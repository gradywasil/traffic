/**
 * Control-system behavior tests (task F5): the wired pipeline
 * (ControlSystem.step → CarWorld.step) exercising the claim lifecycle
 * against the real F4 world — red holds, green grants, permissive-left
 * yield vs oncoming through, protected-left phases, stop-sign FIFO
 * departure order, the simultaneous right tiebreak, and left-vs-oncoming
 * through at a stop sign (acceptance: "construct arrival sequences, assert
 * grant order incl. a simultaneous-arrival tiebreak and a
 * left-vs-oncoming-through case").
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../config';
import { createDefaultConfig, DEFAULT_MODEL_PARAMS } from '../../config/defaults';
import { getPreset } from '../../presets';
import { buildIntersectionGeometry } from '../../geom';
import type { IntersectionGeometry } from '../../geom';
import { hashCarStore } from '../hash';
import { createCarWorld } from '../world';
import type { CarWorld } from '../world';
import { createControlSystem } from './system';
import type { ControlSystem } from './system';

const LEN = DEFAULT_MODEL_PARAMS.carLengthMeters;

interface Setup {
  readonly config: IntersectionConfig;
  readonly geometry: IntersectionGeometry;
  readonly world: CarWorld;
  readonly control: ControlSystem;
}

function makeSetup(config: IntersectionConfig): Setup {
  const geometry = buildIntersectionGeometry(config);
  const world = createCarWorld(geometry, config, { capacity: 64 });
  const control = createControlSystem(geometry, config, { capacity: 64 });
  return { config, geometry, world, control };
}

function stopSignConfig(): IntersectionConfig {
  const base = createDefaultConfig();
  return { ...base, control: { type: 'all-way-stop' } };
}

function movementIndexOf(geometry: IntersectionGeometry, arm: string, lane: number, turn: string): number {
  const index = geometry.movements.findIndex((m) => m.id === `${arm}:${String(lane)}:${turn}`);
  if (index < 0) throw new Error(`movement ${arm}:${String(lane)}:${turn} not found`);
  return index;
}

function spawnAt(world: CarWorld, geometry: IntersectionGeometry, mIdx: number, s: number, v: number): number {
  return world.store.addCar({ pathIndex: mIdx, s, speed: v, carLengthMeters: LEN }, world.tick, geometry.movements);
}

function step(setup: Setup): void {
  setup.world.step(setup.control.step(setup.world));
}

function grantTicks(control: ControlSystem, mIdx: number): number[] {
  return control.claims.grantLog.filter((g) => g.pathIndex === mIdx).map((g) => g.tick);
}

function firstGrantTick(control: ControlSystem, mIdx: number): number {
  const ticks = grantTicks(control, mIdx);
  if (ticks.length === 0) throw new Error(`no grant for movement ${String(mIdx)}`);
  return ticks[0] as number;
}

// ---------------------------------------------------------------------------
// Signal mode
// ---------------------------------------------------------------------------

describe('signal mode: red hold and green grant (claim lifecycle)', () => {
  it('an approaching car on red parks ON the stop line, is granted at green, then clears and departs', () => {
    const setup = makeSetup(createDefaultConfig());
    const { world, control, geometry } = setup;
    const mIdx = movementIndexOf(geometry, 'east', 0, 'through');
    const stopLineS = geometry.movements[mIdx]?.stopLineS ?? 0;
    const id = spawnAt(world, geometry, mIdx, 0, 13.9);
    void id;

    // EW is red for the whole NS phase: green 0..259, yellow 260..292, all-red 293..298.
    for (let tick = 0; tick < 299; tick += 1) {
      step(setup);
      const dense = world.store.indexOfEntity(id);
      const s = dense >= 0 ? world.store.s[dense] : Number.NaN;
      // Never crosses ungranted: the terminal clamp bounds the settling
      // overshoot at s0 − s_min = 1.5 m past the line.
      expect(s, `tick ${String(tick)}`).toBeLessThanOrEqual(stopLineS + 1.6);
    }
    expect(grantTicks(control, mIdx)).toEqual([]);

    // Held at the line: front bumper parked on it (within settling slack), stopped.
    const held = world.store.s[world.store.indexOfEntity(id)] ?? 0;
    expect(Math.abs(held - stopLineS)).toBeLessThanOrEqual(2.0);
    expect(world.store.speed[world.store.indexOfEntity(id)] ?? 1).toBeLessThan(0.5);

    // EW green starts at tick 299: grant, cross, clear, depart.
    let departed = false;
    for (let tick = 299; tick < 1200 && !departed; tick += 1) {
      step(setup);
      departed = world.store.count === 0;
    }
    expect(firstGrantTick(control, mIdx)).toBeGreaterThanOrEqual(299);
    expect(departed).toBe(true);
    const record = control.claims.recordOf(id);
    expect(record?.phase ?? 'cleared').toBe('cleared');
    expect(control.claims.stats.ungrantedLineCrossings).toBe(0);
    expect(world.clampCount).toBe(0);
    expect(control.claims.holdersOfZone(geometry.conflictZones[0]?.id ?? '')).toEqual([]); // holds released
  });

  it('a car with green authority is not braked from afar (T-F5b barrier gating)', () => {
    // The stop-line barrier is erected only from the request line onward
    // (phase PENDING — comfortable stopping distance + one tick + margin,
    // R1 §4.2). A lone through car green for its whole approach must hold
    // cruise until the line and never see the virtual leader; previously
    // the erection-regardless-of-distance barrier shed it to ~7.5 m/s.
    const setup = makeSetup(createDefaultConfig());
    const { world, geometry } = setup;
    const mIdx = movementIndexOf(geometry, 'north', 0, 'through');
    const stopLineS = geometry.movements[mIdx]?.stopLineS ?? 0;
    const id = spawnAt(world, geometry, mIdx, 0, 13.9);

    // NS green 0..259: authority for the whole approach, zones free.
    let minSpeedBeforeLine = 13.9;
    let completed = false;
    for (let tick = 0; tick < 900 && !completed; tick += 1) {
      step(setup);
      const dense = world.store.indexOfEntity(id);
      if (dense < 0) {
        completed = true;
        break;
      }
      if ((world.store.s[dense] ?? 0) < stopLineS) {
        minSpeedBeforeLine = Math.min(minSpeedBeforeLine, world.store.speed[dense] ?? 0);
      }
    }
    expect(completed).toBe(true);
    expect(minSpeedBeforeLine).toBeGreaterThanOrEqual(13.9 - 1e-9); // full cruise all the way in
    expect(world.clampCount).toBe(0);
    expect(setup.control.claims.stats.ungrantedLineCrossings).toBe(0);
  });

  it('a car that must stop still gets the barrier with stopping-sight lead (T-F5b)', () => {
    // Red for the whole approach (EW under the NS phase): the car cruises
    // until the request window, then brakes INSIDE it and parks on the
    // line — the gating must not delay the hold past the point where a
    // comfortable stop is still possible (b = 2.0; measured peak ~2.8,
    // well inside the b_e = 6.0 envelope; clamp stays 0).
    const setup = makeSetup(createDefaultConfig());
    const { world, geometry } = setup;
    const mIdx = movementIndexOf(geometry, 'east', 0, 'through');
    const stopLineS = geometry.movements[mIdx]?.stopLineS ?? 0;
    const b = setup.config.modelParams.comfortableDecelMps2;
    const dt = setup.config.dt;
    const id = spawnAt(world, geometry, mIdx, 0, 13.9);

    let peakDecel = 0;
    let prevSpeed = 13.9;
    for (let tick = 0; tick < 299; tick += 1) {
      step(setup);
      const dense = world.store.indexOfEntity(id);
      const speed = (world.store.speed[dense] ?? 0);
      peakDecel = Math.max(peakDecel, (prevSpeed - speed) / dt);
      prevSpeed = speed;
      expect((world.store.s[dense] ?? 0), `tick ${String(tick)}`).toBeLessThanOrEqual(stopLineS + 1.6);
    }
    const dense = world.store.indexOfEntity(id);
    expect(Math.abs((world.store.s[dense] ?? 0) - stopLineS)).toBeLessThanOrEqual(2.0);
    expect((world.store.speed[dense] ?? 1)).toBeLessThan(0.5);
    // Comfortable-and-safe bracket: at least b·(1+slack for IDM ramp), at
    // most the emergency envelope (a cap-bound stop would near b_e).
    expect(peakDecel).toBeGreaterThan(b);
    expect(peakDecel).toBeLessThan(setup.config.modelParams.emergencyDecelMps2);
    expect(world.clampCount).toBe(0);
    expect(setup.control.claims.stats.ungrantedLineCrossings).toBe(0);
  });
});

describe('signal mode: permissive left yields oncoming through (τ_clear gate)', () => {
  it('the through is granted first; the left waits until the oncoming path is clear', () => {
    const setup = makeSetup(createDefaultConfig());
    const { world, control, geometry } = setup;
    const leftIdx = movementIndexOf(geometry, 'north', 0, 'left');
    const throughIdx = movementIndexOf(geometry, 'south', 0, 'through');
    const leftStop = geometry.movements[leftIdx]?.stopLineS ?? 0;
    spawnAt(world, geometry, leftIdx, leftStop, 0); // stopped at the line
    // Oncoming through placed INSIDE the τ_clear window (≈2 s from the
    // shared conflict zone): a genuine threat, not an open gap.
    spawnAt(world, geometry, throughIdx, leftStop - 2 * 13.9, 13.9);

    for (let tick = 0; tick < 400; tick += 1) step(setup);
    expect(grantTicks(control, throughIdx).length).toBe(1);
    expect(grantTicks(control, leftIdx).length).toBe(1);
    expect(firstGrantTick(control, throughIdx)).toBeLessThan(firstGrantTick(control, leftIdx));
    expect(control.claims.stats.deniedYield).toBeGreaterThan(0); // the gate actually fired
    expect(world.clampCount).toBe(0);
  });

  it('a left may take a genuine gap: oncoming beyond τ_clear does not block it', () => {
    const setup = makeSetup(createDefaultConfig());
    const { world, control, geometry } = setup;
    const leftIdx = movementIndexOf(geometry, 'north', 0, 'left');
    const throughIdx = movementIndexOf(geometry, 'south', 0, 'through');
    const leftStop = geometry.movements[leftIdx]?.stopLineS ?? 0;
    spawnAt(world, geometry, leftIdx, leftStop, 0);
    spawnAt(world, geometry, throughIdx, 0, 13.9); // ~8 s out at spawn — an open gap

    for (let tick = 0; tick < 30; tick += 1) step(setup);
    expect(firstGrantTick(control, leftIdx)).toBeLessThan(30); // took the gap immediately
    expect(control.claims.grantLog.some((g) => g.pathIndex === throughIdx && g.tick < 30)).toBe(false);
  });

  it('opposing permissive lefts never deadlock (FIFO exemption where zones are shared)', () => {
    const setup = makeSetup(createDefaultConfig());
    const { world, control, geometry } = setup;
    const northLeft = movementIndexOf(geometry, 'north', 0, 'left');
    const southLeft = movementIndexOf(geometry, 'south', 0, 'left');
    const northId = spawnAt(world, geometry, northLeft, geometry.movements[northLeft]?.stopLineS ?? 0, 0);
    const southId = spawnAt(world, geometry, southLeft, geometry.movements[southLeft]?.stopLineS ?? 0, 0);
    void northId;
    void southId;

    for (let tick = 0; tick < 600; tick += 1) step(setup);
    // In the 1-lane geometry the opposing left arcs clear each other
    // (≥ 10 m apart — like real opposing lefts), so both go; where a
    // geometry shares their zones, the FIFO exemption serializes them.
    // Either way: both granted, nobody stuck.
    expect(grantTicks(control, northLeft).length).toBe(1);
    expect(grantTicks(control, southLeft).length).toBe(1);
    expect(world.store.count).toBe(0);
    expect(world.clampCount).toBe(0);
  });
});

describe('signal mode: protected lefts (4-phase plan)', () => {
  it('a dedicated left is granted in its own protected phase, through only in the through phase', () => {
    const setup = makeSetup(getPreset('balanced').config);
    const { world, control, geometry } = setup;
    const leftIdx = movementIndexOf(geometry, 'north', 0, 'left');
    const throughIdx = movementIndexOf(geometry, 'north', 1, 'through');
    spawnAt(world, geometry, leftIdx, geometry.movements[leftIdx]?.stopLineS ?? 0, 0);
    spawnAt(world, geometry, throughIdx, geometry.movements[throughIdx]?.stopLineS ?? 0, 0);

    for (let tick = 0; tick < 500; tick += 1) step(setup);
    // P0 (ns-protected-left green) spans ticks 0..69.
    expect(firstGrantTick(control, leftIdx)).toBeLessThan(70);
    // P1 (ns-through-right green) starts at tick 112.
    expect(firstGrantTick(control, throughIdx)).toBeGreaterThanOrEqual(112);
    // Protected lefts carry no yield gate.
    expect(control.claims.stats.deniedYield).toBe(0);
    expect(world.clampCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// All-way stop mode
// ---------------------------------------------------------------------------

describe('all-way stop: FIFO departure order (acceptance)', () => {
  it('grants follow stop-line arrival order across arms', () => {
    const setup = makeSetup(stopSignConfig());
    const { world, control, geometry } = setup;
    const northIdx = movementIndexOf(geometry, 'north', 0, 'through');
    const southIdx = movementIndexOf(geometry, 'south', 0, 'through');
    const eastIdx = movementIndexOf(geometry, 'east', 0, 'through');

    // Arrival order N (t=0) → S (t=40) → E (t=80). N and S are opposing
    // throughs (no shared zone — they pass side by side); E conflicts with
    // both, so its grant is serialized behind whichever holds the box.
    spawnAt(world, geometry, northIdx, geometry.movements[northIdx]?.stopLineS ?? 0, 0);
    for (let tick = 0; tick < 40; tick += 1) step(setup);
    spawnAt(world, geometry, southIdx, geometry.movements[southIdx]?.stopLineS ?? 0, 0);
    for (let tick = 0; tick < 40; tick += 1) step(setup);
    spawnAt(world, geometry, eastIdx, geometry.movements[eastIdx]?.stopLineS ?? 0, 0);
    for (let tick = 0; tick < 600; tick += 1) step(setup);

    expect(grantTicks(control, northIdx)).toHaveLength(1);
    expect(grantTicks(control, southIdx)).toHaveLength(1);
    expect(grantTicks(control, eastIdx)).toHaveLength(1);
    expect(firstGrantTick(control, northIdx)).toBeLessThan(firstGrantTick(control, southIdx));
    expect(firstGrantTick(control, southIdx)).toBeLessThan(firstGrantTick(control, eastIdx));
    expect(control.claims.stats.ungrantedLineCrossings).toBe(0);
  });

  it('simultaneous arrival: the car on the right departs first, the other waits for the box', () => {
    const setup = makeSetup(stopSignConfig());
    const { world, control, geometry } = setup;
    const northIdx = movementIndexOf(geometry, 'north', 0, 'through');
    const westIdx = movementIndexOf(geometry, 'west', 0, 'through');
    // Both stop at the line on the same tick (constructed simultaneous arrival).
    spawnAt(world, geometry, northIdx, geometry.movements[northIdx]?.stopLineS ?? 0, 0);
    spawnAt(world, geometry, westIdx, geometry.movements[westIdx]?.stopLineS ?? 0, 0);

    for (let tick = 0; tick < 400; tick += 1) step(setup);

    expect(firstGrantTick(control, westIdx)).toBeLessThan(firstGrantTick(control, northIdx));
    // The north car was serialized behind the west car's conflict zones.
    expect(firstGrantTick(control, northIdx) - firstGrantTick(control, westIdx)).toBeGreaterThan(10);
    expect(control.claims.stats.deniedExclusivity).toBeGreaterThan(0);
  });

  it('left yields oncoming through: the through departs first despite a later stop', () => {
    const setup = makeSetup(stopSignConfig());
    const { world, control, geometry } = setup;
    const leftIdx = movementIndexOf(geometry, 'north', 0, 'left');
    const throughIdx = movementIndexOf(geometry, 'south', 0, 'through');
    // Simultaneous stop: the left holds the earlier ticket by arm order, but
    // oncoming through traffic is a threat that never yields to a left.
    const leftId = spawnAt(world, geometry, leftIdx, geometry.movements[leftIdx]?.stopLineS ?? 0, 0);
    spawnAt(world, geometry, throughIdx, geometry.movements[throughIdx]?.stopLineS ?? 0, 0);

    for (let tick = 0; tick < 600; tick += 1) step(setup);

    expect(grantTicks(control, leftIdx)).toHaveLength(1);
    expect(grantTicks(control, throughIdx)).toHaveLength(1);
    expect(firstGrantTick(control, throughIdx)).toBeLessThan(firstGrantTick(control, leftIdx));
    expect(control.claims.stats.deniedYield).toBeGreaterThan(0);
    // The left finally departs and clears (no deadlock).
    expect(control.claims.recordOf(leftId)?.phase ?? 'cleared').toBe('cleared');
    expect(world.store.count).toBe(0);
    expect(world.clampCount).toBe(0);
  });
});

describe('determinism at the control-system level', () => {
  it('same scripted schedule ⇒ identical store+control hash sequence', () => {
    const run = (): string[] => {
      const config = stopSignConfig();
      const setup = makeSetup(config);
      const { world, control, geometry } = setup;
      const hashes: string[] = [];
      let spawnCursor = 0;
      for (let tick = 0; tick < 900; tick += 1) {
        if (tick % 37 === 0 && spawnCursor < 40) {
          const mIdx = spawnCursor % geometry.movements.length;
          spawnAt(world, geometry, mIdx, 0, 8);
          spawnCursor += 1;
        }
        step(setup);
        if ((tick + 1) % 150 === 0) {
          hashes.push(
            hashCarStore(world.store, world.tick, [
              world.clampCount,
              control.claims.stats.grants,
              control.claims.stats.releases,
              control.claims.stats.deniedYield,
            ]),
          );
        }
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});
