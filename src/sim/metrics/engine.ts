/**
 * Metrics engine (task F7) — influence-zone metrics per research R1 §6.1,
 * consumed (never recomputed) from F3's geometry baselines.
 *
 * **Per-car control delay:** `delay = (t_exit − t_entry) − FF(p)` where
 * t_entry/t_exit are front-bumper gate-crossing sim times detected from the
 * store's prev→curr motion each tick (`prevS < gateS ≤ s`; cars never move
 * backward, R1 §3.2). Crossings are attributed to the END of the tick they
 * happen in — tick-quantized, so a perfectly free-flow car measures delay in
 * (−dt, +dt) by construction. FF(p), the gate positions and the stop lines
 * come from `MovementGeometry` (F3 outputs; not recomputed here).
 *
 * **Stopped-time:** a tick counts as stopped when the car's END-of-tick
 * state is inside the influence zone (entryGateS ≤ s ≤ exitGateS) with speed
 * < METRICS_STOPPED_SPEED_MPS (0.5 m/s, R1 §6.1). Difference vs control
 * delay — the documented slow-roll contribution: delay also charges the
 * deceleration/acceleration ramps around a stop and any sub-threshold
 * crawling; stopped-time charges none of that. A fully stopped car of
 * duration K measures stopped-time ≈ K (± a settle tick) and control delay
 * = K + ramps. During full-arm spillback, zone delay saturates while
 * stopped-time stalls — the queue metrics are the unbounded signal there
 * (R1 §6.1 honesty caveat, surfaced in the overlay docs).
 *
 * **Trip completion:** a trip completes at exit-gate crossing (throughput is
 * measured AT the exit gate, R1 §6.1) — typically a few seconds before the
 * despawn departure. The departure records handed over by F6
 * (`Spawner.trips` / `world.departures`) close the remaining edge cases:
 * a car crossing the exit gate and reaching the path end within the same
 * tick (exit time falls back to the departure time) and the bookkeeping
 * cleanup. Entities that vanish without any record are reaped best-effort
 * from their last-seen state (insertion order — deterministic).
 *
 * **Queue:** per (arm, lane) chain — cars whose front bumper is still
 * upstream of the stop line (s ≤ stopLineS) with speed below the stopped
 * threshold, sampled every tick. Arm-level queue = sum over the arm's lanes
 * at the same tick. Windowed maxima use monotonic deques over sim time
 * (exact sliding-window maximum, O(1) amortized). Virtual entry queues
 * (spawner spillback) are NOT counted — they are demand yet to enter the
 * world; the spawner exposes their depth separately.
 *
 * **Throughput:** completed trips per window, converted to veh/h over
 * span = min(window, time since stats reset) — the early-run ramp divides
 * by the honest elapsed time instead of a full window it hasn't lived.
 *
 * **Stats reset (config-change signal):** U2/O2 call `reset()` whenever the
 * config changes — clears every aggregate and re-anchors the window span at
 * the next observe (town-hall §MVP.7 "stats window resets on config
 * change"). Trips in flight are re-baselined: their entry time falls back
 * to the first post-reset observation, the trip is flagged `rebaselined`,
 * and flagged trips are excluded from the aggregates (their delay is
 * understated by construction and would spike the fresh window downward
 * exactly when the user is watching it respond to the change).
 *
 * **Determinism (R2 Part C):** IEEE-exact ops only; the live-trip Map is
 * probed by stable entity id and swept in insertion order (never iterated
 * for order-sensitive state from arbitrary keys); samples live in a plain
 * array in completion order; queue values are integers. Quantization stays
 * out of the aggregates — it is a reporting-boundary concern owned by the
 * run-hash (Q1, `DualLaneDigest.quantized10`).
 */
import { ARM_IDS } from '../../config';
import type { ArmId, IntersectionConfig, TurnDirection } from '../../config';
import type { IntersectionGeometry, MovementGeometry } from '../../geom';
import { itemAt } from '../../geom';
import { f64At, i32At } from '../store';
import { DEFAULT_METRICS_WINDOW_SECONDS, METRICS_STOPPED_SPEED_MPS } from './constants';
import { meanOf, percentileOfSorted, sortedAscending } from './stats';
import type {
  ArmMetrics,
  CompletedTripMetrics,
  MetricsDeparture,
  MetricsEngineOptions,
  MetricsSnapshot,
  MetricsWorldView,
  RunSummary,
} from './types';

/** Chain count: 4 arms × 3 lanes max, indexed `armIndex·3 + laneIndex`. */
const CHAIN_COUNT = 12;

/** Precomputed per-movement facts (pure function of geometry; hot-loop data). */
interface MovementFacts {
  readonly pathIndex: number;
  readonly armIndex: number;
  readonly arm: ArmId;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  readonly chain: number;
  readonly entryGateS: number;
  readonly exitGateS: number;
  readonly stopLineS: number;
  readonly freeFlowSeconds: number;
}

/** Live per-car accumulation state, keyed by stable store entity id. */
interface LiveTrip {
  readonly entityId: number;
  readonly facts: MovementFacts;
  /** First-seen time — the entry-time fallback for re-baselined trips. */
  readonly firstSeenTime: number;
  entryTime: number | null;
  /** Entry time came from the first-seen fallback, not a gate crossing. */
  entryRebaselined: boolean;
  stoppedTicks: number;
  completed: boolean;
  lastSeenTick: number;
  lastSeenTime: number;
}

/**
 * Exact sliding-window maximum over a value-per-timestamp stream, via a
 * monotonic deque (values dominated by a newer equal-or-larger value are
 * dropped at push; expired front entries are dropped on read). Timestamps
 * must be pushed non-decreasing (sim time is). Integer values.
 */
class WindowMax {
  private readonly times: number[] = [];
  private readonly values: number[] = [];

  push(time: number, value: number): void {
    while (this.values.length > 0 && itemAt(this.values, this.values.length - 1) <= value) {
      this.times.pop();
      this.values.pop();
    }
    this.times.push(time);
    this.values.push(value);
  }

  /** Windowed max at `time`; entries with timestamp ≤ time − windowSeconds expire. */
  max(time: number, windowSeconds: number): number {
    const cutoff = time - windowSeconds;
    while (this.times.length > 0 && itemAt(this.times, 0) <= cutoff) {
      this.times.shift();
      this.values.shift();
    }
    return this.values.length > 0 ? itemAt(this.values, 0) : 0;
  }

  clear(): void {
    this.times.length = 0;
    this.values.length = 0;
  }
}

export class MetricsEngine {
  readonly geometry: IntersectionGeometry;
  readonly dt: number;

  private windowSecondsState: number;

  private readonly facts: readonly MovementFacts[];
  private readonly laneCountOfArm: readonly number[];
  private readonly liveTrips = new Map<number, LiveTrip>();
  /** Completed trips in completion order; index 0 is the oldest. */
  private readonly samples: CompletedTripMetrics[] = [];

  private readonly chainQueue = new Int32Array(CHAIN_COUNT);
  private readonly lastQueuePerChain = new Int32Array(CHAIN_COUNT);
  private readonly chainWindowMax: WindowMax[] = [];
  private readonly armWindowMax: WindowMax[] = [];
  private readonly totalWindowMax = new WindowMax();
  private readonly chainMaxSinceReset = new Int32Array(CHAIN_COUNT);
  private readonly armMaxSinceReset = new Int32Array(4);
  private totalMaxSinceReset = 0;

  private tripsSinceReset = 0;
  private delaySumSinceReset = 0;
  private stoppedSumSinceReset = 0;
  private droppedDepartures = 0;
  private resetTime: number | null = null;
  private lastTime = 0;

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig, options: MetricsEngineOptions = {}) {
    this.geometry = geometry;
    this.dt = config.dt;
    this.windowSecondsState = options.windowSeconds ?? DEFAULT_METRICS_WINDOW_SECONDS;
    if (!(this.windowSecondsState > 0) || !Number.isFinite(this.windowSecondsState)) {
      throw new Error(`metrics window must be finite > 0 s, got ${String(options.windowSeconds)}`);
    }

    this.facts = geometry.movements.map((movement: MovementGeometry, pathIndex: number) => {
      const armIndex = ARM_IDS.indexOf(movement.arm);
      return {
        pathIndex,
        armIndex,
        arm: movement.arm,
        laneIndex: movement.laneIndex,
        turn: movement.turn,
        chain: armIndex * 3 + movement.laneIndex,
        entryGateS: movement.entryGateS,
        exitGateS: movement.exitGateS,
        stopLineS: movement.stopLineS,
        freeFlowSeconds: movement.freeFlowSeconds,
      };
    });
    this.laneCountOfArm = ARM_IDS.map((armId) => config.arms[armId].lanes.length);
    for (let chain = 0; chain < CHAIN_COUNT; chain += 1) this.chainWindowMax.push(new WindowMax());
    for (let arm = 0; arm < 4; arm += 1) this.armWindowMax.push(new WindowMax());
  }

  /** Rolling window length in sim-seconds. */
  get windowSeconds(): number {
    return this.windowSecondsState;
  }

  /**
   * Change the window length. Narrowing drops samples immediately; widening
   * re-trims against the new cutoff but cannot resurrect samples already
   * expired under a narrower window (documented, not silently regenerated).
   */
  setWindowSeconds(seconds: number): void {
    if (!(seconds > 0) || !Number.isFinite(seconds)) {
      throw new Error(`metrics window must be finite > 0 s, got ${String(seconds)}`);
    }
    this.windowSecondsState = seconds;
    this.trimSamples();
  }

  /**
   * Observe one completed tick. Call AFTER `world.step(...)` (and after the
   * spawner, so freshly admitted cars are seen) with the tick's departures —
   * F6's `TripRecord`s or the raw `world.departures`. Returns the trips that
   * completed this tick, in completion order (exit-gate crossings in dense
   * store order, then departure-closed stragglers in departure order, then
   * reaped entities in first-seen order — all deterministic).
   */
  observe(world: MetricsWorldView, departures?: readonly MetricsDeparture[]): readonly CompletedTripMetrics[] {
    const store = world.store;
    const tick = world.tick;
    const time = world.time;
    if (this.resetTime === null) this.resetTime = time;
    this.lastTime = time;
    const completed: CompletedTripMetrics[] = [];
    this.chainQueue.fill(0);

    // 1. Per-car pass over the dense store: gate crossings + stopped-time + queue.
    for (let i = 0; i < store.count; i += 1) {
      const id = i32At(store.entityId, i);
      const sPrev = f64At(store.prevS, i);
      const sNow = f64At(store.s, i);
      const v = f64At(store.speed, i);
      let rec = this.liveTrips.get(id);
      if (rec === undefined) {
        rec = {
          entityId: id,
          facts: itemAt(this.facts, i32At(store.pathIndex, i)),
          firstSeenTime: time,
          entryTime: null,
          entryRebaselined: false,
          stoppedTicks: 0,
          completed: false,
          lastSeenTick: tick,
          lastSeenTime: time,
        };
        this.liveTrips.set(id, rec);
        if (sPrev >= rec.facts.entryGateS) {
          // First sight already past the entry gate BEFORE this tick's
          // motion: post-reset in-flight car or degenerate geometry (spawn
          // inside the zone). Re-baseline from now and flag — the trip's
          // delay is understated by construction, so it will not feed the
          // aggregates. (A car crossing the gate during its first observed
          // tick — sPrev < gate ≤ sNow — is a true crossing, handled below.)
          rec.entryTime = time;
          rec.entryRebaselined = true;
        }
      }
      rec.lastSeenTick = tick;
      rec.lastSeenTime = time;
      const f = rec.facts;

      if (rec.entryTime === null && sPrev < f.entryGateS && sNow >= f.entryGateS) {
        rec.entryTime = time; // strict front-bumper gate crossing this tick
      }
      if (!rec.completed && sPrev < f.exitGateS && sNow >= f.exitGateS) {
        completed.push(this.finalize(rec, time));
      }
      if (!rec.completed && sNow >= f.entryGateS && sNow <= f.exitGateS && v < METRICS_STOPPED_SPEED_MPS) {
        rec.stoppedTicks += 1;
      }
      if (sNow <= f.stopLineS && v < METRICS_STOPPED_SPEED_MPS) {
        this.chainQueue[f.chain] = i32At(this.chainQueue, f.chain) + 1;
      }
    }

    // 2. Departures (F6 seam): close same-tick cross-and-depart stragglers at
    //    the departure time, then release the records.
    if (departures !== undefined) {
      for (const dep of departures) {
        const rec = this.liveTrips.get(dep.entityId);
        if (rec === undefined) {
          // The engine never observed this entity (attached mid-run after it
          // had already completed, or a malformed feed); counted, never
          // silently dropped.
          this.droppedDepartures += 1;
          continue;
        }
        const departTime = dep.timeSeconds ?? dep.departTimeSeconds;
        if (departTime === undefined) {
          throw new Error(`departure for entity ${String(dep.entityId)} carries no departure time`);
        }
        if (!rec.completed) completed.push(this.finalize(rec, departTime));
        this.liveTrips.delete(dep.entityId);
      }
    }

    // 3. Reap entities that left the store without a departure record
    //    (harness-only in production); finalize from last-seen state.
    for (const rec of this.liveTrips.values()) {
      if (rec.lastSeenTick < tick) {
        if (!rec.completed) completed.push(this.finalize(rec, rec.lastSeenTime));
        this.liveTrips.delete(rec.entityId);
      }
    }

    // 4. Queue bookkeeping: per-chain counts → arm totals → grand total,
    //    each into its windowed-max deque and monotonic since-reset maximum.
    const armTotals = [0, 0, 0, 0];
    let total = 0;
    for (let chain = 0; chain < CHAIN_COUNT; chain += 1) {
      const q = i32At(this.chainQueue, chain);
      itemAt(this.chainWindowMax, chain).push(time, q);
      if (q > i32At(this.chainMaxSinceReset, chain)) this.chainMaxSinceReset[chain] = q;
      const arm = Math.floor(chain / 3);
      armTotals[arm] = itemAt(armTotals, arm) + q;
      total += q;
    }
    for (let arm = 0; arm < 4; arm += 1) {
      const q = itemAt(armTotals, arm);
      itemAt(this.armWindowMax, arm).push(time, q);
      if (q > i32At(this.armMaxSinceReset, arm)) this.armMaxSinceReset[arm] = q;
    }
    this.totalWindowMax.push(time, total);
    if (total > this.totalMaxSinceReset) this.totalMaxSinceReset = total;
    this.lastQueuePerChain.set(this.chainQueue);

    this.trimSamples();
    return completed;
  }

  /** Rolling-window snapshot at the last observed sim time. */
  snapshot(): MetricsSnapshot {
    const time = this.lastTime;
    const window = this.windowSecondsState;

    let stoppedSum = 0;
    const delays: number[] = [];
    const perArmCount = [0, 0, 0, 0];
    const perArmDelay = [0, 0, 0, 0];
    const perArmStopped = [0, 0, 0, 0];
    for (const sample of this.samples) {
      delays.push(sample.controlDelaySeconds);
      stoppedSum += sample.stoppedSeconds;
      const a = sample.armIndex;
      perArmCount[a] = itemAt(perArmCount, a) + 1;
      perArmDelay[a] = itemAt(perArmDelay, a) + sample.controlDelaySeconds;
      perArmStopped[a] = itemAt(perArmStopped, a) + sample.stoppedSeconds;
    }
    const span = this.windowSpanSeconds(time);
    const tripCount = this.samples.length;

    const arms = {} as Record<ArmId, ArmMetrics>;
    for (let armIndex = 0; armIndex < 4; armIndex += 1) {
      const armId = itemAt(ARM_IDS, armIndex);
      const count = itemAt(perArmCount, armIndex);
      const laneCount = itemAt(this.laneCountOfArm, armIndex);
      const maxQueuePerLane: number[] = [];
      for (let lane = 0; lane < laneCount; lane += 1) {
        maxQueuePerLane.push(itemAt(this.chainWindowMax, armIndex * 3 + lane).max(time, window));
      }
      arms[armId] = {
        arm: armId,
        tripCount: count,
        meanControlDelaySeconds: count > 0 ? itemAt(perArmDelay, armIndex) / count : null,
        meanStoppedSeconds: count > 0 ? itemAt(perArmStopped, armIndex) / count : null,
        throughputVehPerHour: count > 0 && span > 0 ? (count * 3600) / span : null,
        maxQueueCars: itemAt(this.armWindowMax, armIndex).max(time, window),
        maxQueuePerLane,
      };
    }

    const sortedDelays = sortedAscending(delays);
    return {
      timeSeconds: time,
      windowSeconds: window,
      elapsedSinceResetSeconds: time - (this.resetTime ?? time),
      tripCount,
      meanControlDelaySeconds: meanOf(delays),
      controlDelayP50Seconds: percentileOfSorted(sortedDelays, 0.5),
      controlDelayP85Seconds: percentileOfSorted(sortedDelays, 0.85),
      controlDelayP95Seconds: percentileOfSorted(sortedDelays, 0.95),
      meanStoppedSeconds: tripCount > 0 ? stoppedSum / tripCount : null,
      throughputVehPerHour: tripCount > 0 && span > 0 ? (tripCount * 3600) / span : null,
      maxQueueCars: this.totalWindowMax.max(time, window),
      currentQueuePerChain: Array.from(this.lastQueuePerChain),
      arms,
    };
  }

  /** Cumulative since-reset summary (O1's ranking input). */
  runSummary(): RunSummary {
    const elapsed = this.lastTime - (this.resetTime ?? this.lastTime);
    return {
      elapsedSeconds: elapsed,
      tripCount: this.tripsSinceReset,
      meanControlDelaySeconds: this.tripsSinceReset > 0 ? this.delaySumSinceReset / this.tripsSinceReset : null,
      meanStoppedSeconds: this.tripsSinceReset > 0 ? this.stoppedSumSinceReset / this.tripsSinceReset : null,
      throughputVehPerHour:
        this.tripsSinceReset > 0 && elapsed > 0 ? (this.tripsSinceReset * 3600) / elapsed : null,
      maxQueueCars: this.totalMaxSinceReset,
      maxQueuePerChain: Array.from(this.chainMaxSinceReset),
    };
  }

  /**
   * Stats-reset signal: call on every config change (U2 live-apply, O2 plan
   * apply). Clears every aggregate, queue maximum and in-flight trip; the
   * window span re-anchors at the next observe. In-flight cars re-baseline
   * from their first post-reset observation (entry-time fallback).
   */
  reset(): void {
    this.liveTrips.clear();
    this.samples.length = 0;
    this.chainQueue.fill(0);
    this.lastQueuePerChain.fill(0);
    for (const deque of this.chainWindowMax) deque.clear();
    for (const deque of this.armWindowMax) deque.clear();
    this.totalWindowMax.clear();
    this.chainMaxSinceReset.fill(0);
    this.armMaxSinceReset.fill(0);
    this.totalMaxSinceReset = 0;
    this.tripsSinceReset = 0;
    this.delaySumSinceReset = 0;
    this.stoppedSumSinceReset = 0;
    this.resetTime = null;
  }

  /** Departures seen for entities this engine never observed (diagnostic). */
  get droppedDepartureCount(): number {
    return this.droppedDepartures;
  }

  /** Window span for throughput denominators: min(window, time since reset). */
  private windowSpanSeconds(time: number): number {
    return Math.min(this.windowSecondsState, Math.max(time - (this.resetTime ?? time), 0));
  }

  /** Drop samples whose exit-gate time has left the window (sim-time based). */
  private trimSamples(): void {
    const cutoff = this.lastTime - this.windowSecondsState;
    while (this.samples.length > 0 && itemAt(this.samples, 0).exitTimeSeconds <= cutoff) {
      this.samples.shift();
    }
  }

  /**
   * Complete a trip: compute the delay against FF(p), record the sample.
   * Re-baselined trips (fallback entry time) are returned for bookkeeping
   * but kept out of the aggregates — see `CompletedTripMetrics.rebaselined`.
   */
  private finalize(rec: LiveTrip, exitTime: number): CompletedTripMetrics {
    rec.completed = true;
    const f = rec.facts;
    const entryTime = rec.entryTime ?? rec.firstSeenTime;
    const delay = exitTime - entryTime - f.freeFlowSeconds;
    const stoppedSeconds = rec.stoppedTicks * this.dt;
    if (!Number.isFinite(delay) || !Number.isFinite(stoppedSeconds)) {
      throw new Error(
        `non-finite metric for entity ${String(rec.entityId)}: delay=${String(delay)} stopped=${String(stoppedSeconds)}`,
      );
    }
    const sample: CompletedTripMetrics = {
      entityId: rec.entityId,
      pathIndex: f.pathIndex,
      armIndex: f.armIndex,
      arm: f.arm,
      laneIndex: f.laneIndex,
      turn: f.turn,
      entryTimeSeconds: entryTime,
      exitTimeSeconds: exitTime,
      freeFlowSeconds: f.freeFlowSeconds,
      controlDelaySeconds: delay,
      stoppedSeconds,
      rebaselined: rec.entryRebaselined,
    };
    if (!rec.entryRebaselined) {
      this.samples.push(sample);
      this.tripsSinceReset += 1;
      this.delaySumSinceReset += delay;
      this.stoppedSumSinceReset += stoppedSeconds;
    }
    return sample;
  }
}
