/**
 * Car world / systems tests (task F4 acceptance):
 * - single car on an empty path traverses at cruise speed, never exceeding
 *   the kinematic limits (accel ≤ a, decel ≤ b, speed ≤ v_c);
 * - leader-following produces stable spacing, queue + discharge, with
 *   no overlap ever (min gap ≥ s_min across randomized soak seeds);
 * - deterministic given identical inputs (same seed ⇒ identical store hash);
 * - 150-car tick budget < 4 ms on this machine (measured and reported).
 *
 * The soak drives the F5 constraint seam with a crude test-side pseudo
 * signal (alternating NS/EW greens with all-red gaps, dilemma-zone-aware
 * barrier erection per R1 §3.1) — F5 replaces this with the real controller.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, LaneConfig } from '../config';
import { ARM_IDS } from '../config';
import type { ArmId } from '../config';
import { createDefaultConfig, DEFAULT_MODEL_PARAMS } from '../config/defaults';
import type { IntersectionGeometry, MovementGeometry } from '../geom';
import { buildIntersectionGeometry, itemAt } from '../geom';
import { hashCarStore } from './hash';
import { f64At, i32At, unconstrainedConstraints } from './store';
import type { CarConstraints } from './store';
import { createCarWorld } from './world';
import type { CarWorld } from './world';

const P = DEFAULT_MODEL_PARAMS;
const DT = 0.1;
const LEN = P.carLengthMeters;
const GAP_EPS = 1e-9;

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

function movementIndexOf(geometry: IntersectionGeometry, arm: ArmId, lane: number, turn: string): number {
  const index = geometry.movements.findIndex((m) => m.id === `${arm}:${String(lane)}:${turn}`);
  if (index < 0) throw new Error(`movement ${arm}:${String(lane)}:${turn} not found`);
  return index;
}

/**
 * R1 §3.2 spawn-hold rule (test-side stand-in for F6): the entry segment must
 * offer s_min + v_c·T of room beyond the rearmost car's rear bumper, i.e.
 * rearmost s ≥ len + s_min + v_c·T — spawning closer creates a car inside the
 * emergency envelope of the queue ahead.
 */
function spawnRoomMeters(config: IntersectionConfig, arm: ArmId): number {
  return (
    LEN + P.hardMinGapMeters + config.arms[arm].cruiseSpeedMps * P.timeHeadwaySeconds
  );
}

function addCar(world: CarWorld, geometry: IntersectionGeometry, pathIndex: number, s: number, speed: number): number {
  return world.store.addCar({ pathIndex, s, speed, carLengthMeters: LEN }, world.tick, geometry.movements);
}

/**
 * Minimum qualifying same-chain bumper gap (mirrors the implementation's
 * leader rule): consecutive cars in a lane chain, pair qualifies when same
 * movement or the ahead car's rear bumper is still on the shared approach.
 */
function minChainGap(world: CarWorld, geometry: IntersectionGeometry): number {
  const store = world.store;
  const chains = new Map<number, number[]>();
  for (let i = 0; i < store.count; i += 1) {
    const movement = itemAt(geometry.movements, i32At(store.pathIndex, i));
    const key = chainKeyOf(movement);
    const bucket = chains.get(key);
    if (bucket === undefined) chains.set(key, [i]);
    else bucket.push(i);
  }
  let min = Infinity;
  for (const bucket of chains.values()) {
    bucket.sort((a, b) => f64At(store.s, b) - f64At(store.s, a));
    const stopLineS = itemAt(geometry.movements, i32At(store.pathIndex, itemAt(bucket, 0))).stopLineS;
    for (let k = 1; k < bucket.length; k += 1) {
      const ahead = itemAt(bucket, k - 1);
      const behind = itemAt(bucket, k);
      const samePath = i32At(store.pathIndex, ahead) === i32At(store.pathIndex, behind);
      const rearOnApproach =
        f64At(store.s, ahead) - f64At(store.carLengthMeters, ahead) <= stopLineS;
      if (samePath || rearOnApproach) {
        const gap = f64At(store.s, ahead) - f64At(store.carLengthMeters, ahead) - f64At(store.s, behind);
        if (gap < min) min = gap;
      }
    }
  }
  return min;
}

// ---------------------------------------------------------------------------
// Acceptance: single car on an empty path
// ---------------------------------------------------------------------------

describe('single car on an empty path', () => {
  const config = createDefaultConfig();
  const geometry = buildIntersectionGeometry(config);

  it('through movement: cruise traversal within kinematic limits, then departs', () => {
    const world = createCarWorld(geometry, config);
    const mIdx = movementIndexOf(geometry, 'north', 0, 'through');
    addCar(world, geometry, mIdx, 0, 0);
    const movement = geometry.movements[mIdx] as MovementGeometry;

    let prevV = 0;
    let maxSpeed = 0;
    let maxAccel = 0;
    let maxDecel = 0;
    let prevS = 0;
    let departedAtTick = -1;
    for (let t = 0; t < 3000 && departedAtTick < 0; t += 1) {
      world.step();
      const v = world.store.speed[0] as number;
      const s = world.store.s[0] as number;
      maxSpeed = Math.max(maxSpeed, v);
      maxAccel = Math.max(maxAccel, v - prevV);
      maxDecel = Math.max(maxDecel, prevV - v);
      expect(s).toBeGreaterThanOrEqual(prevS - GAP_EPS); // never backward
      prevV = v;
      prevS = s;
      if (world.departures.length > 0) departedAtTick = world.tick;
    }

    expect(departedAtTick).toBeGreaterThan(0);
    expect(maxSpeed).toBeLessThanOrEqual(config.arms.north.cruiseSpeedMps + 1e-9);
    expect(maxAccel).toBeLessThanOrEqual(P.maxAccelerationMps2 * DT + 1e-9);
    expect(maxDecel).toBeLessThanOrEqual(P.comfortableDecelMps2 * DT + 1e-6);
    expect(world.clampCount).toBe(0);
    const record = world.departures[0];
    expect(record).toBeDefined();
    expect(record?.tick).toBe(departedAtTick);
    expect(record?.pathIndex).toBe(mIdx);
    expect(record?.exitSpeedMps ?? 0).toBeGreaterThan(10); // exits at cruise
    expect((geometry.movements[mIdx] as MovementGeometry).lengthMeters).toBeGreaterThan(0);
    expect(world.store.count).toBe(0); // despawn-at-exit removed it
    void movement;
  });

  it('right turn: slows to v_t in the curve, never above v_c, decel ≤ b', () => {
    const world = createCarWorld(geometry, config);
    const mIdx = movementIndexOf(geometry, 'north', 0, 'right');
    const movement = geometry.movements[mIdx] as MovementGeometry;
    addCar(world, geometry, mIdx, 0, 0);

    let prevV = 0;
    let maxSpeed = 0;
    let maxDecel = 0;
    let midCurveSpeed: number | null = null;
    for (let t = 0; t < 3000; t += 1) {
      world.step();
      if (world.store.count === 0) break;
      const v = world.store.speed[0] as number;
      const s = world.store.s[0] as number;
      maxSpeed = Math.max(maxSpeed, v);
      maxDecel = Math.max(maxDecel, prevV - v);
      prevV = v;
      if (midCurveSpeed === null && s > (movement.curveStartS + movement.curveEndS) / 2) {
        midCurveSpeed = v;
      }
    }
    expect(world.store.count).toBe(0); // completed the turn path
    expect(maxSpeed).toBeLessThanOrEqual(config.arms.north.cruiseSpeedMps + 1e-9);
    expect(maxDecel).toBeLessThanOrEqual(P.comfortableDecelMps2 * DT + 1e-6);
    expect(midCurveSpeed).not.toBeNull();
    // Holds v_t through the curve within the one-tick cap overshoot (b·dt).
    expect(midCurveSpeed as number).toBeGreaterThan(movement.turnSpeedMps - 0.25);
    expect(midCurveSpeed as number).toBeLessThan(movement.turnSpeedMps + 0.25);
    expect(world.clampCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Acceptance: leader-following stability, queue, discharge, constraint seam
// ---------------------------------------------------------------------------

describe('leader-following', () => {
  const config = createDefaultConfig();
  const geometry = buildIntersectionGeometry(config);
  const mIdx = movementIndexOf(geometry, 'north', 0, 'through');

  function holdBarrierAt(world: CarWorld, barrierS: number): CarConstraints {
    const constraints = unconstrainedConstraints(world.store.count);
    for (let i = 0; i < world.store.count; i += 1) constraints.barrierS[i] = barrierS;
    return constraints;
  }

  it('approaching a stopped leader queues at ≈ s0 with no overlap, then discharges', () => {
    const world = createCarWorld(geometry, config);
    const leader = addCar(world, geometry, mIdx, 150, config.arms.north.cruiseSpeedMps);
    const follower = addCar(world, geometry, mIdx, 100, config.arms.north.cruiseSpeedMps);
    expect(leader).not.toBe(follower);

    // Phase 1: a wall at s=220 stops the leader; the follower queues behind.
    let minGap = Infinity;
    for (let t = 0; t < 500; t += 1) {
      world.step(holdBarrierAt(world, 220));
      const gap =
        (world.store.s[0] as number) - LEN - (world.store.s[1] as number);
      minGap = Math.min(minGap, gap);
      expect(minGap).toBeGreaterThanOrEqual(P.hardMinGapMeters - GAP_EPS);
    }
    const queuedGap = (world.store.s[0] as number) - LEN - (world.store.s[1] as number);
    expect(world.store.speed[0] as number).toBeLessThan(0.2);
    expect(world.store.speed[1] as number).toBeLessThan(0.2);
    expect(queuedGap).toBeGreaterThan(P.hardMinGapMeters);
    expect(queuedGap).toBeLessThan(P.minGapMeters + 1.0); // ≈ s0 spacing
    expect(world.clampCount).toBe(0);

    // Phase 2: release — both discharge and complete their trips.
    let departed = 0;
    for (let t = 0; t < 1500; t += 1) {
      world.step();
      departed += world.departures.length;
      if (world.store.count === 2) {
        const gap = (world.store.s[0] as number) - LEN - (world.store.s[1] as number);
        expect(gap).toBeGreaterThanOrEqual(P.hardMinGapMeters - GAP_EPS);
      }
    }
    expect(departed).toBe(2);
    expect(world.store.count).toBe(0);
    expect(world.clampCount).toBe(0);
  });

  it('stable spacing at speed: platoon neither collapses nor disperses', () => {
    const world = createCarWorld(geometry, config);
    addCar(world, geometry, mIdx, 130, config.arms.north.cruiseSpeedMps);
    addCar(world, geometry, mIdx, 85, config.arms.north.cruiseSpeedMps);
    let minGap = Infinity;
    let maxGap = 0;
    let maxDeltaV = 0;
    for (let t = 0; t < 300 && world.store.count === 2; t += 1) {
      world.step();
      if (world.store.count < 2) break; // leader departed: indices go stale
      const gap = (world.store.s[0] as number) - LEN - (world.store.s[1] as number);
      minGap = Math.min(minGap, gap);
      maxGap = Math.max(maxGap, gap);
      maxDeltaV = Math.max(
        maxDeltaV,
        Math.abs((world.store.speed[0] as number) - (world.store.speed[1] as number)),
      );
    }
    // Started 40 m apart at cruise; the follower eases off toward IDM
    // equilibrium and the gap drifts up slowly — bounded, no oscillation blow-up.
    expect(minGap).toBeGreaterThanOrEqual(P.hardMinGapMeters - GAP_EPS);
    expect(minGap).toBeGreaterThan(35);
    expect(maxGap).toBeLessThan(55);
    expect(maxDeltaV).toBeLessThan(1.0);
    expect(world.clampCount).toBe(0);
  });

  it('constraint seam: an external speed cap holds the car below the cap', () => {
    const world = createCarWorld(geometry, config);
    addCar(world, geometry, mIdx, 0, 0);
    let maxSpeed = 0;
    for (let t = 0; t < 400; t += 1) {
      const constraints = unconstrainedConstraints(world.store.count);
      constraints.speedCapMps[0] = 8;
      world.step(constraints);
      maxSpeed = Math.max(maxSpeed, world.store.speed[0] as number);
    }
    expect(maxSpeed).toBeLessThanOrEqual(8 + 1e-9);
  });

  it('prev-snapshot + interpolated pose follow the F1 world contract', () => {
    const world = createCarWorld(geometry, config);
    addCar(world, geometry, mIdx, 0, 0);
    for (let t = 0; t < 50; t += 1) world.step();
    const before = world.carPose(0, 0);
    const after = world.carPose(0, 1);
    const middle = world.carPose(0, 0.5);
    // alpha=0 → previous tick, alpha=1 → current tick (north arm runs along y).
    expect(after.y).not.toBe(before.y);
    expect(middle.y).toBeCloseTo((before.y + after.y) / 2, 9);
    expect(middle.x).toBeCloseTo(before.x, 9); // lane centerline: x constant
    const norm = Math.sqrt(middle.hx * middle.hx + middle.hy * middle.hy);
    expect(norm).toBeCloseTo(1, 9);
    expect(middle.speedMps).toBeGreaterThanOrEqual(before.speedMps - 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Soak: randomized seeds, pseudo-signal barriers, no overlap, clamp = 0
// ---------------------------------------------------------------------------

/** Pseudo signal: 25 s NS green, 4 s all-red, 25 s EW green, 4 s all-red. */
function axisGreen(arm: ArmId, tick: number): boolean {
  const phase = tick % 580;
  if (arm === 'north' || arm === 'south') return phase < 250;
  return phase >= 290 && phase < 540;
}

interface SoakResult {
  readonly world: CarWorld;
  readonly hashes: string[];
  readonly minGap: number;
  readonly departed: number;
  readonly peakAlive: number;
}

function soakRun(
  config: IntersectionConfig,
  geometry: IntersectionGeometry,
  seed: number,
  ticks: number,
  spawnProb = 0.03,
): SoakResult {
  const world = createCarWorld(geometry, config, { capacity: 400 });
  const lcg = new TestLcg(seed);
  const hashes: string[] = [];
  let minGap = Infinity;
  let departed = 0;
  let peakAlive = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    // Test-side pseudo controller through the F5 constraint seam.
    const constraints = unconstrainedConstraints(world.store.count);
    for (let i = 0; i < world.store.count; i += 1) {
      const movement = geometry.movements[world.store.pathIndex[i] as number] as MovementGeometry;
      if (axisGreen(movement.arm, tick)) continue;
      const barrier = movement.stopLineS + P.minGapMeters; // parks bumpers on the line
      const v = world.store.speed[i] as number;
      const distance = barrier - (world.store.s[i] as number);
      // Dilemma-zone rule (R1 §3.1): hold only if a comfortable stop remains
      // possible; cars past the point of no return keep going (pseudo-yellow).
      if (distance > 0 && distance >= (v * v) / (2 * P.comfortableDecelMps2)) {
        constraints.barrierS[i] = barrier;
      }
    }

    world.step(constraints);
    departed += world.departures.length;
    peakAlive = Math.max(peakAlive, world.store.count);

    // Spawning (test-side stand-in for F6): Bernoulli per movement per tick,
    // admitted only with room — spillback-blocked arrivals are dropped
    // deterministically.
    for (let m = 0; m < geometry.movements.length; m += 1) {
      if (lcg.next() >= spawnProb) continue;
      const movement = geometry.movements[m] as MovementGeometry;
      const key = chainKeyOf(movement);
      let rearmost = Infinity;
      for (let i = 0; i < world.store.count; i += 1) {
        const other = geometry.movements[world.store.pathIndex[i] as number] as MovementGeometry;
        if (chainKeyOf(other) === key) rearmost = Math.min(rearmost, world.store.s[i] as number);
      }
      if (rearmost >= spawnRoomMeters(config, movement.arm)) {
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

    minGap = Math.min(minGap, minChainGap(world, geometry));
    if ((tick + 1) % 250 === 0) {
      hashes.push(hashCarStore(world.store, world.tick, [world.clampCount, world.safeCapBindCount]));
    }
  }
  return { world, hashes, minGap, departed, peakAlive };
}

describe('randomized soak (pseudo-signal, shared-lane traffic)', () => {
  const config = createDefaultConfig();
  const geometry = buildIntersectionGeometry(config);
  const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
  const TICKS = 4000;

  it('never overlaps (min gap ≥ s_min), never fires the terminal clamp', { timeout: 120_000 }, () => {
    for (const seed of SEEDS) {
      const result = soakRun(config, geometry, seed, TICKS);
      expect(result.minGap, `seed ${String(seed)}`).toBeGreaterThanOrEqual(P.hardMinGapMeters - GAP_EPS);
      expect(result.world.clampCount, `seed ${String(seed)}`).toBe(0);
      expect(result.departed, `seed ${String(seed)}`).toBeGreaterThan(50); // real flow
      expect(result.peakAlive, `seed ${String(seed)}`).toBeGreaterThan(10); // real queues
      expect(result.world.tick).toBe(TICKS);
      // All state finite (hash would have thrown otherwise) and bounded.
      for (let i = 0; i < result.world.store.count; i += 1) {
        expect(result.world.store.speed[i] as number).toBeGreaterThanOrEqual(0);
        expect(result.world.store.s[i] as number).toBeLessThan(300);
      }
    }
  });

  it(
    'same seed ⇒ identical store-state hash sequence; different seed ⇒ different',
    // 3 × 1500-tick soaks — explicit timeout per the suite hardening pass
    // (T-F5b follow-up: same remedy as the 8-seed soak above).
    { timeout: 60_000 },
    () => {
    const a = soakRun(config, geometry, 12345, 1500);
    const b = soakRun(config, geometry, 12345, 1500);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.world.clampCount).toBe(b.world.clampCount);
    const c = soakRun(config, geometry, 12346, 1500);
    expect(c.hashes[c.hashes.length - 1]).not.toBe(a.hashes[a.hashes.length - 1]);
  });

  it('deterministic at the hash level for a fixed scripted spawn schedule too', () => {
    const run = (): string => {
      const world = createCarWorld(geometry, config);
      for (let t = 0; t < 200; t += 1) {
        if (t % 7 === 0 && t < 70) {
          const m = (t / 7) % geometry.movements.length;
          world.store.addCar(
            { pathIndex: m, s: 0, speed: 8, carLengthMeters: LEN },
            t,
            geometry.movements,
          );
        }
        world.step();
      }
      return hashCarStore(world.store, world.tick, [world.clampCount, world.safeCapBindCount]);
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
// Acceptance: 150-car tick budget
// ---------------------------------------------------------------------------

describe('performance: 150 cars', () => {
  it('step() median tick stays far under the 4 ms budget', () => {
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

    // Keep ~150 cars alive: round-robin spawns with room checks, plus the
    // pseudo-signal barriers so queues (the expensive state) are exercised.
    const topUp = (): void => {
      let cursor = 0;
      let passStart = cursor;
      while (world.store.count < 150) {
        const m = cursor % geometry.movements.length;
        cursor = (cursor + 1) % geometry.movements.length;
        if (cursor === passStart) break; // one full pass without success
        const movement = geometry.movements[m] as MovementGeometry;
        const key = chainKeyOf(movement);
        let rearmost = Infinity;
        for (let i = 0; i < world.store.count; i += 1) {
          const other = geometry.movements[world.store.pathIndex[i] as number] as MovementGeometry;
          if (chainKeyOf(other) === key) rearmost = Math.min(rearmost, world.store.s[i] as number);
        }
        if (rearmost >= spawnRoomMeters(config, movement.arm)) {
          world.store.addCar(
            { pathIndex: m, s: 0, speed: config.arms.north.cruiseSpeedMps, carLengthMeters: LEN },
            world.tick,
            geometry.movements,
          );
          passStart = cursor;
        }
      }
    };
    const signal = (): CarConstraints => {
      const constraints = unconstrainedConstraints(world.store.count);
      for (let i = 0; i < world.store.count; i += 1) {
        const movement = geometry.movements[world.store.pathIndex[i] as number] as MovementGeometry;
        if (axisGreen(movement.arm, world.tick)) continue;
        const barrier = movement.stopLineS + P.minGapMeters;
        const v = world.store.speed[i] as number;
        const distance = barrier - (world.store.s[i] as number);
        if (distance > 0 && distance >= (v * v) / (2 * P.comfortableDecelMps2)) {
          constraints.barrierS[i] = barrier;
        }
      }
      return constraints;
    };

    for (let t = 0; t < 300; t += 1) {
      topUp();
      world.step(signal());
    }

    const durations: number[] = [];
    let minAlive = Infinity;
    for (let t = 0; t < 1000; t += 1) {
      topUp();
      const constraints = signal(); // constraint building is F5's budget, excluded
      const t0 = performance.now();
      world.step(constraints);
      const t1 = performance.now();
      durations.push(t1 - t0);
      minAlive = Math.min(minAlive, world.store.count);
    }
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)] as number;
    const p99 = durations[Math.floor(durations.length * 0.99)] as number;
    const max = durations[durations.length - 1] as number;
    // Measured honestly and reported (see production-log T-F4 entry).
    console.info(
      `[perf] 150-car tick over ${String(durations.length)} steps: median=${median.toFixed(4)} ms, p99=${p99.toFixed(4)} ms, max=${max.toFixed(4)} ms, min alive=${String(minAlive)}`,
    );
    expect(median).toBeLessThan(4);
    expect(minAlive).toBeGreaterThanOrEqual(100); // population genuinely held
    expect(world.clampCount).toBe(0);
  });
});
