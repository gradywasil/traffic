/**
 * Randomized soak (task F5 acceptance — the executable form of the R1 §3.2
 * theorems): >= 10k seeded ticks per config across signal 2-phase
 * (permissive lefts), signal 4-phase (protected lefts) and all-way stop,
 * with mixed turning traffic, asserting:
 * - no two cars' footprints (F3 capsule model) ever intersect — checked
 *   through the geometry's segment-distance footprint test, every tick;
 * - the layer-3 clamp never fires and no car ever crosses a stop line
 *   without a grant;
 * - determinism: same seed ⇒ identical hash sequence (store + control
 *   counters);
 * - real flow (departures, queues, grants) so the soak is meaningful.
 *
 * Plus the 150-car tick-budget measurement of the control system (F5's
 * share of the tick), mirroring the F4 perf test.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, LaneConfig } from '../../config';
import { ARM_IDS } from '../../config';
import { createDefaultConfig, DEFAULT_MODEL_PARAMS } from '../../config/defaults';
import { getPreset } from '../../presets';
import { buildIntersectionGeometry } from '../../geom';
import type { IntersectionGeometry, MovementGeometry } from '../../geom';
import { CAR_WIDTH_METERS, segmentDistance, sampleAtS } from '../../geom';
import { hashCarStore } from '../hash';
import { f64At, i32At } from '../store';
import { createCarWorld } from '../world';
import type { CarWorld } from '../world';
import { createControlSystem } from './system';
import type { ControlSystem } from './system';

const P = DEFAULT_MODEL_PARAMS;
const LEN = P.carLengthMeters;
const HALF_LEN = (LEN - CAR_WIDTH_METERS) / 2;
/** Capsules overlap only if centers are closer than 2·halfLen + width = len. */
const CENTER_PRUNE_METERS = LEN + 0.01;
const OVERLAP_EPS = 1e-7;

/** Deterministic 31-bit LCG — TEST DRIVER ONLY (the sim RNG is F6's). */
class TestLcg {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) === 0 ? 1 : seed | 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1103515245) + 12345) & 0x7fffffff;
    return this.state / 0x80000000;
  }
}

function chainKeyOf(movement: MovementGeometry): number {
  return ARM_IDS.indexOf(movement.arm) * 3 + movement.laneIndex;
}

function stopSignConfig(): IntersectionConfig {
  const base = createDefaultConfig();
  return { ...base, control: { type: 'all-way-stop' } };
}

interface SoakSummary {
  readonly ticks: number;
  readonly departed: number;
  readonly peakAlive: number;
  readonly grants: number;
  readonly deniedYield: number;
  readonly deniedExitHeadroom: number;
  readonly deniedExclusivity: number;
  readonly minFootprintDistance: number;
  readonly clampCount: number;
  readonly ungrantedLineCrossings: number;
}

interface SoakResult extends SoakSummary {
  readonly hashes: readonly string[];
}

/**
 * Drive one soak: Bernoulli spawns per movement per tick (mixed turning by
 * construction — every movement of the config fires), R1 §3.2 room rule,
 * full pairwise footprint check every tick, hash checkpoints every 250
 * ticks.
 */
function soak(
  config: IntersectionConfig,
  seed: number,
  ticks: number,
  spawnProbability: number,
): SoakResult {
  const geometry: IntersectionGeometry = buildIntersectionGeometry(config);
  const world: CarWorld = createCarWorld(geometry, config, { capacity: 600 });
  const control: ControlSystem = createControlSystem(geometry, config, { capacity: 600 });
  const lcg = new TestLcg(seed);
  const hashes: string[] = [];
  const spawnRoom = LEN + P.hardMinGapMeters + config.arms.north.cruiseSpeedMps * P.timeHeadwaySeconds;

  let departed = 0;
  let peakAlive = 0;
  let minFootprint = Number.POSITIVE_INFINITY;
  const cx = new Float64Array(600);
  const cy = new Float64Array(600);
  const ax1 = new Float64Array(600);
  const ay1 = new Float64Array(600);
  const ax2 = new Float64Array(600);
  const ay2 = new Float64Array(600);

  for (let tick = 0; tick < ticks; tick += 1) {
    const constraints = control.step(world);
    world.step(constraints);
    departed += world.departures.length;
    const alive = world.store.count;
    if (alive > peakAlive) peakAlive = alive;

    // Test-side spawner (F6's stand-in): Bernoulli per movement per tick,
    // admitted only with entry room; blocked arrivals drop deterministically.
    for (let m = 0; m < geometry.movements.length; m += 1) {
      if (lcg.next() >= spawnProbability) continue;
      const movement = geometry.movements[m];
      if (movement === undefined) continue;
      const key = chainKeyOf(movement);
      let rearmost = Number.POSITIVE_INFINITY;
      for (let i = 0; i < world.store.count; i += 1) {
        const other = geometry.movements[i32At(world.store.pathIndex, i)];
        if (other !== undefined && chainKeyOf(other) === key) {
          rearmost = Math.min(rearmost, f64At(world.store.s, i));
        }
      }
      if (rearmost >= spawnRoom) {
        world.store.addCar(
          {
            pathIndex: m,
            s: 0,
            speed: config.arms[movement.arm].cruiseSpeedMps,
            carLengthMeters: LEN,
          },
          tick,
          geometry.movements,
        );
      }
    }

    // Footprint non-intersection (F3 capsule model), every tick, all pairs
    // (AABB-pruned on centers).
    const store = world.store;
    const n = store.count;
    for (let i = 0; i < n; i += 1) {
      const movement = geometry.movements[i32At(store.pathIndex, i)];
      if (movement === undefined) continue;
      const sample = sampleAtS(movement.samples, f64At(store.s, i));
      cx[i] = sample.x;
      cy[i] = sample.y;
      ax1[i] = sample.x - sample.hx * HALF_LEN;
      ay1[i] = sample.y - sample.hy * HALF_LEN;
      ax2[i] = sample.x + sample.hx * HALF_LEN;
      ay2[i] = sample.y + sample.hy * HALF_LEN;
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = (cx[i] as number) - (cx[j] as number);
        const dy = (cy[i] as number) - (cy[j] as number);
        if (dx > CENTER_PRUNE_METERS || dx < -CENTER_PRUNE_METERS) continue;
        if (dy > CENTER_PRUNE_METERS || dy < -CENTER_PRUNE_METERS) continue;
        const distance = segmentDistance(
          { x: ax1[i] as number, y: ay1[i] as number },
          { x: ax2[i] as number, y: ay2[i] as number },
          { x: ax1[j] as number, y: ay1[j] as number },
          { x: ax2[j] as number, y: ay2[j] as number },
        );
        if (distance < minFootprint) minFootprint = distance;
        if (distance < CAR_WIDTH_METERS - OVERLAP_EPS) {
          throw new Error(
            `footprint overlap at tick ${String(tick)}: cars ${String(i32At(store.entityId, i))}/` +
              `${String(i32At(store.entityId, j))} distance ${distance.toFixed(4)} m < ${String(CAR_WIDTH_METERS)} m`,
          );
        }
      }
    }

    if ((tick + 1) % 250 === 0) {
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

  const stats = control.claims.stats;
  return {
    ticks,
    departed,
    peakAlive,
    grants: stats.grants,
    deniedYield: stats.deniedYield,
    deniedExitHeadroom: stats.deniedExitHeadroom,
    deniedExclusivity: stats.deniedExclusivity,
    minFootprintDistance: minFootprint,
    clampCount: world.clampCount,
    ungrantedLineCrossings: stats.ungrantedLineCrossings,
    hashes,
  };
}

function expectCleanSoak(result: SoakSummary, label: string, minDepartures: number): void {
  expect(result.clampCount, `${label} clamp`).toBe(0);
  expect(result.ungrantedLineCrossings, `${label} ungranted crossings`).toBe(0);
  expect(result.minFootprintDistance, `${label} footprint`).toBeGreaterThanOrEqual(CAR_WIDTH_METERS - OVERLAP_EPS);
  expect(result.departed, `${label} departures`).toBeGreaterThan(minDepartures); // real flow
  expect(result.peakAlive, `${label} queues`).toBeGreaterThan(15); // real contention
  expect(result.grants, `${label} grants`).toBeGreaterThan(minDepartures);
}

const TICKS = 10_000;

describe('randomized soak: footprint non-intersection across control modes', () => {
  it(
    'signal 2-phase, permissive lefts, shared lanes (seeded, 10k ticks)',
    { timeout: 240_000 },
    () => {
      const result = soak(createDefaultConfig(), 90210, TICKS, 0.005);
      console.info('[soak] signal-2p:', JSON.stringify({ ...result, hashes: result.hashes.length }, null, 0));
      expectCleanSoak(result, 'signal-2p', 200);
      expect(result.deniedYield, 'signal-2p left-yield gate fired').toBeGreaterThan(0);
    },
  );

  it(
    'signal 4-phase, protected lefts, dedicated lanes (seeded, 10k ticks)',
    { timeout: 240_000 },
    () => {
      const result = soak(getPreset('balanced').config, 424242, TICKS, 0.005);
      console.info('[soak] signal-4p:', JSON.stringify({ ...result, hashes: result.hashes.length }, null, 0));
      expectCleanSoak(result, 'signal-4p', 200);
    },
  );

  it(
    'all-way stop, shared lanes, mixed turns (seeded, 10k ticks)',
    { timeout: 240_000 },
    () => {
      const result = soak(stopSignConfig(), 7777, TICKS, 0.0015);
      // An oversaturated all-way stop sustains ~500 veh/h here (heavy FIFO
      // serialization) — 100+ departures per 1000 s is genuine, saturated flow.
      console.info('[soak] all-way-stop:', JSON.stringify({ ...result, hashes: result.hashes.length }, null, 0));
      expectCleanSoak(result, 'stop', 100);
      expect(result.deniedYield, 'stop left-yield gate fired').toBeGreaterThan(0);
    },
  );

  it(
    'second seed per mode: contention variety',
    { timeout: 240_000 },
    () => {
      const a = soak(createDefaultConfig(), 31337, TICKS, 0.006);
      const b = soak(getPreset('balanced').config, 5150, TICKS, 0.006);
      const c = soak(stopSignConfig(), 600613, TICKS, 0.002);
      expectCleanSoak(a, 'signal-2p#2', 150);
      expectCleanSoak(b, 'signal-4p#2', 200);
      expectCleanSoak(c, 'stop#2', 100);
    },
  );
});

describe('soak determinism (acceptance: same seed ⇒ same hash sequence)', () => {
  it(
    'identical hash checkpoints on re-runs of the same seed per mode',
    { timeout: 240_000 },
    () => {
      const a = soak(createDefaultConfig(), 12345, 5000, 0.005);
      const b = soak(createDefaultConfig(), 12345, 5000, 0.005);
      expect(a.hashes).toEqual(b.hashes);
      const c = soak(getPreset('balanced').config, 98765, 5000, 0.005);
      const d = soak(getPreset('balanced').config, 98765, 5000, 0.005);
      expect(c.hashes).toEqual(d.hashes);
      const e = soak(stopSignConfig(), 55555, 5000, 0.0015);
      const f = soak(stopSignConfig(), 55555, 5000, 0.0015);
      expect(e.hashes).toEqual(f.hashes);
      // Different seeds diverge (the hashes are genuinely sensitive).
      const g = soak(createDefaultConfig(), 12346, 5000, 0.005);
      expect(g.hashes[g.hashes.length - 1]).not.toBe(a.hashes[a.hashes.length - 1]);
    },
  );
});

describe('performance: control system tick budget at 150 cars', () => {
  it('control.step + world.step stay far under the 4 ms tick budget', { timeout: 120_000 }, () => {
    const base = createDefaultConfig();
    const lanes: LaneConfig[] = [
      { designations: ['left'] },
      { designations: ['through'] },
      { designations: ['through', 'right'] },
    ];
    const arm = { ...base.arms.north, lanes };
    const config: IntersectionConfig = { ...base, arms: { north: arm, east: arm, south: arm, west: arm } };
    const geometry = buildIntersectionGeometry(config);
    const world = createCarWorld(geometry, config, { capacity: 400 });
    const control = createControlSystem(geometry, config, { capacity: 400 });
    const spawnRoom = LEN + P.hardMinGapMeters + config.arms.north.cruiseSpeedMps * P.timeHeadwaySeconds;

    const topUp = (): void => {
      let cursor = 0;
      let passStart = cursor;
      while (world.store.count < 150) {
        const m = cursor % geometry.movements.length;
        cursor = (cursor + 1) % geometry.movements.length;
        if (cursor === passStart) break;
        const movement = geometry.movements[m];
        if (movement === undefined) continue;
        const key = chainKeyOf(movement);
        let rearmost = Number.POSITIVE_INFINITY;
        for (let i = 0; i < world.store.count; i += 1) {
          const other = geometry.movements[i32At(world.store.pathIndex, i)];
          if (other !== undefined && chainKeyOf(other) === key) {
            rearmost = Math.min(rearmost, f64At(world.store.s, i));
          }
        }
        if (rearmost >= spawnRoom) {
          world.store.addCar(
            { pathIndex: m, s: 0, speed: config.arms.north.cruiseSpeedMps, carLengthMeters: LEN },
            world.tick,
            geometry.movements,
          );
          passStart = cursor;
        }
      }
    };

    for (let t = 0; t < 300; t += 1) {
      topUp();
      world.step(control.step(world));
    }

    const controlDurations: number[] = [];
    const worldDurations: number[] = [];
    let minAlive = Number.POSITIVE_INFINITY;
    for (let t = 0; t < 1000; t += 1) {
      topUp();
      const t0 = performance.now();
      const constraints = control.step(world);
      const t1 = performance.now();
      world.step(constraints);
      const t2 = performance.now();
      controlDurations.push(t1 - t0);
      worldDurations.push(t2 - t1);
      minAlive = Math.min(minAlive, world.store.count);
    }
    const medianOf = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] as number;
    };
    const controlMedian = medianOf(controlDurations);
    const controlP99 = [...controlDurations].sort((a, b) => a - b)[Math.floor(controlDurations.length * 0.99)] as number;
    const worldMedian = medianOf(worldDurations);
    console.info(
      `[perf] 150-car control.step: median=${controlMedian.toFixed(4)} ms, p99=${controlP99.toFixed(4)} ms; ` +
        `world.step median=${worldMedian.toFixed(4)} ms; combined median=${(controlMedian + worldMedian).toFixed(4)} ms; ` +
        `min alive=${String(minAlive)}; clamp=${String(world.clampCount)}`,
    );
    expect(controlMedian + worldMedian).toBeLessThan(4); // the shared tick budget
    expect(minAlive).toBeGreaterThanOrEqual(100);
    expect(world.clampCount).toBe(0);
    expect(control.claims.stats.ungrantedLineCrossings).toBe(0);
  });
});
