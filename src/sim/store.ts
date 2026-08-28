/**
 * ECS-style car store (task F4): dense entities, components in parallel
 * typed arrays — GC-free per tick (R1 §3.2 budget note), stable dense-index
 * iteration order (R2 Part C rule 5: entity iteration uses dense integer ids
 * in index order).
 *
 * Components (all parallel arrays indexed by dense entity index 0..count-1):
 * - transform-on-path: `s` (front-bumper arc length on the assigned path),
 *   `speed`;
 * - route: `pathIndex` (index into `geometry.movements` — the movement /
 *   (arm, lane, turn) the car drives, fixed for the car's life; no lane
 *   changes, MVP);
 * - kinematics: `carLengthMeters` (footprint; per-car so F6 can vary it);
 * - render snapshots: `prevS` / `prevSpeed` — the previous tick's values the
 *   renderer interpolates from (the F1 world.ts prev/curr contract);
 * - bookkeeping: `entityId` (stable across swap-removals — what F5/F6/F7 hold
 *   references with), `spawnTick`.
 *
 * Removal is swap-remove (last entity moves into the hole): O(1), keeps
 * arrays dense; iteration stays index order. All numeric ops are IEEE-exact.
 */
import type { MovementGeometry } from '../geom';

/**
 * Checked typed-array reads (`noUncheckedIndexedAccess` treats typed-array
 * indexing as possibly-undefined; these keep hot loops honest and throw
 * loudly on real bugs — V8 inlines the check away).
 */
export function f64At(values: Float64Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Float64Array index ${String(index)} out of range`);
  return value;
}

/** See `f64At`. */
export function i32At(values: Int32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Int32Array index ${String(index)} out of range`);
  return value;
}

/** Everything needed to spawn one car (F6 fills this in bulk later). */
export interface CarSpawnSpec {
  /** Index into `geometry.movements`. */
  readonly pathIndex: number;
  /** Front-bumper arc length on the path (>= 0). */
  readonly s: number;
  /** Initial speed (m/s, >= 0). */
  readonly speed: number;
  /** Car length (m, > 0) — pass `modelParams.carLengthMeters` by default. */
  readonly carLengthMeters: number;
}

/** One completed trip: front bumper reached the path end (despawn-at-exit). */
export interface DepartureRecord {
  readonly entityId: number;
  readonly pathIndex: number;
  /** Tick the departure happened (1-based: the step that completed it). */
  readonly tick: number;
  readonly timeSeconds: number;
  /** Speed at completion (m/s) — F7's exit-gate throughput input. */
  readonly exitSpeedMps: number;
}

export class CarStore {
  readonly capacity: number;
  /** Number of live entities; iterate `0 .. count-1` in index order. */
  count = 0;

  readonly s: Float64Array;
  readonly prevS: Float64Array;
  readonly speed: Float64Array;
  readonly prevSpeed: Float64Array;
  readonly carLengthMeters: Float64Array;
  readonly pathIndex: Int32Array;
  readonly entityId: Int32Array;
  readonly spawnTick: Int32Array;

  private nextEntityId = 1;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`store capacity must be an integer >= 1, got ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.s = new Float64Array(capacity);
    this.prevS = new Float64Array(capacity);
    this.speed = new Float64Array(capacity);
    this.prevSpeed = new Float64Array(capacity);
    this.carLengthMeters = new Float64Array(capacity);
    this.pathIndex = new Int32Array(capacity);
    this.entityId = new Int32Array(capacity);
    this.spawnTick = new Int32Array(capacity);
  }

  /**
   * Spawn a car; returns its stable entity id. The caller (F6 spawner / tests)
   * must guarantee legal placement: gap to the chain's rearmost car >= s_min.
   */
  addCar(spec: CarSpawnSpec, tick: number, movements: readonly MovementGeometry[]): number {
    if (this.count >= this.capacity) {
      throw new Error(`store at capacity (${String(this.capacity)})`);
    }
    if (!Number.isInteger(spec.pathIndex) || spec.pathIndex < 0 || spec.pathIndex >= movements.length) {
      throw new Error(`pathIndex out of range: ${String(spec.pathIndex)}`);
    }
    if (!Number.isFinite(spec.s) || spec.s < 0) throw new Error(`s must be finite >= 0, got ${String(spec.s)}`);
    if (!Number.isFinite(spec.speed) || spec.speed < 0) {
      throw new Error(`speed must be finite >= 0, got ${String(spec.speed)}`);
    }
    if (!Number.isFinite(spec.carLengthMeters) || spec.carLengthMeters <= 0) {
      throw new Error(`carLengthMeters must be finite > 0, got ${String(spec.carLengthMeters)}`);
    }
    const i = this.count;
    this.s[i] = spec.s;
    this.prevS[i] = spec.s;
    this.speed[i] = spec.speed;
    this.prevSpeed[i] = spec.speed;
    this.carLengthMeters[i] = spec.carLengthMeters;
    this.pathIndex[i] = spec.pathIndex;
    this.spawnTick[i] = tick;
    const id = this.nextEntityId;
    this.nextEntityId = (id + 1) | 0;
    this.entityId[i] = id;
    this.count = i + 1;
    return id;
  }

  /**
   * Swap-remove the entity at dense `index` (the last entity moves into the
   * hole, carrying all of its components). Indices >= `count` become invalid
   * afterwards — rebuild any index-based side data (constraints included).
   */
  removeAt(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new Error(`remove index out of range: ${String(index)} (count ${String(this.count)})`);
    }
    const last = this.count - 1;
    if (index !== last) {
      this.s[index] = f64At(this.s, last);
      this.prevS[index] = f64At(this.prevS, last);
      this.speed[index] = f64At(this.speed, last);
      this.prevSpeed[index] = f64At(this.prevSpeed, last);
      this.carLengthMeters[index] = f64At(this.carLengthMeters, last);
      this.pathIndex[index] = i32At(this.pathIndex, last);
      this.entityId[index] = i32At(this.entityId, last);
      this.spawnTick[index] = i32At(this.spawnTick, last);
    }
    this.count = last;
  }

  /** Dense index of an entity id, or -1 (linear scan — fine off the hot path). */
  indexOfEntity(entityId: number): number {
    for (let i = 0; i < this.count; i += 1) {
      if (this.entityId[i] === entityId) return i;
    }
    return -1;
  }
}

/**
 * The F5 seam: externally-computed per-car constraints, consumed by the car
 * system each tick. Dense-indexed parallel arrays sized >= `store.count`;
 * `Infinity` = unconstrained. Rebuilt between steps (a step's removals shift
 * dense indices) — the natural pipeline is: step → observe → set constraints
 * → step.
 *
 * - `barrierS`: virtual stopped leader (length 0) at a path position — red
 *   signal / stop-sign hold / denied claim. F5 decides placement (e.g. a stop
 *   line hold that parks front bumpers ON the line sits at
 *   `stopLineS + s0`, since IDM queue equilibrium is s0 and the terminal
 *   clamp floors at s_min) and applies the yellow dilemma-zone rule when
 *   choosing whether to erect it.
 * - `speedCapMps`: additional v_path_max cap for this tick (zone speed
 *   limits, exit-lane headroom, ...).
 */
export interface CarConstraints {
  readonly barrierS: Float64Array;
  readonly speedCapMps: Float64Array;
}

/** Fresh unconstrained buffers for `count` cars (all Infinity). */
export function unconstrainedConstraints(count: number): CarConstraints {
  return {
    barrierS: new Float64Array(count).fill(Infinity),
    speedCapMps: new Float64Array(count).fill(Infinity),
  };
}
