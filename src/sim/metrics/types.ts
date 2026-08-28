/**
 * Metrics-engine types (task F7): the influence-zone trip record (R1 §6.1)
 * and the rolling-window aggregates U3 (display) and O1 (ranking) consume.
 */
import type { ArmId, TurnDirection } from '../../config';
import type { CarStore } from '../store';

/**
 * One completed influence-zone trip — the unit of aggregation.
 *
 * `controlDelaySeconds = (exitTime − entryTime) − FF(p)` with front-bumper
 * gate-crossing times, tick-quantized (each carries an error in [0, dt), so
 * the difference — and hence a perfectly free-flow car's delay — lands in
 * (−dt, +dt) by construction, R1 §6.1). Values of exactly 0 are impossible
 * for real trajectories; small negatives are legal quantization artifacts.
 * `stoppedSeconds` counts whole ticks whose END-of-tick state was inside the
 * zone with speed < `METRICS_STOPPED_SPEED_MPS` (see engine.ts module doc
 * for the stopped-vs-delay difference — the slow-roll contribution).
 */
export interface CompletedTripMetrics {
  readonly entityId: number;
  readonly pathIndex: number;
  readonly armIndex: number;
  readonly arm: ArmId;
  readonly laneIndex: number;
  readonly turn: TurnDirection;
  /** Sim time (s) the front bumper crossed the entry gate (end of that tick). */
  readonly entryTimeSeconds: number;
  /** Sim time (s) the front bumper crossed the exit gate (end of that tick). */
  readonly exitTimeSeconds: number;
  /** FF(p) consumed from F3 geometry (`MovementGeometry.freeFlowSeconds`). */
  readonly freeFlowSeconds: number;
  /** Control delay in seconds — the headline per-car quantity. */
  readonly controlDelaySeconds: number;
  /** Stopped time accumulated inside the influence zone, in seconds. */
  readonly stoppedSeconds: number;
  /**
   * True when the entry time is a re-baseline (first post-reset observation
   * of an in-flight car, or degenerate geometry with the spawn point inside
   * the zone) rather than an observed gate crossing. Re-baselined trips are
   * returned for bookkeeping but EXCLUDED from window aggregates — their
   * delay is understated by construction and would drag the post-config-
   * change window mean down exactly when the user is watching it respond.
   */
  readonly rebaselined: boolean;
}

/** Per-arm rolling-window aggregates (engineering overlay bars, U3). */
export interface ArmMetrics {
  readonly arm: ArmId;
  readonly tripCount: number;
  readonly meanControlDelaySeconds: number | null;
  readonly meanStoppedSeconds: number | null;
  /** Windowed throughput at the exit gates (veh/h); null before any trip. */
  readonly throughputVehPerHour: number | null;
  /**
   * Windowed maximum of the arm-total queue (sum over the arm's lanes,
   * sampled each tick). Max-over-lanes would undercount concurrent lanes.
   */
  readonly maxQueueCars: number;
  /** Windowed maximum queue per lane, `laneIndex` order (length = lane count). */
  readonly maxQueuePerLane: readonly number[];
}

/**
 * Rolling-window snapshot — the display readout (headline = mean control
 * delay, town-hall §MVP.4) and the optimizer's live view. All values derive
 * from samples whose exit-gate time lies inside the window.
 */
export interface MetricsSnapshot {
  /** Sim time of the last observe (the snapshot's "now"). */
  readonly timeSeconds: number;
  readonly windowSeconds: number;
  /** Sim time since the last stats reset (config change signal). */
  readonly elapsedSinceResetSeconds: number;
  readonly tripCount: number;
  /** Headline "average wait": rolling mean control delay (null = no trips). */
  readonly meanControlDelaySeconds: number | null;
  readonly controlDelayP50Seconds: number | null;
  readonly controlDelayP85Seconds: number | null;
  readonly controlDelayP95Seconds: number | null;
  readonly meanStoppedSeconds: number | null;
  /** Aggregate windowed throughput (veh/h) across all arms; null if no trips. */
  readonly throughputVehPerHour: number | null;
  /** Windowed max of the all-arm queue total. */
  readonly maxQueueCars: number;
  /** Current (last tick's) queue per chain, indexed `armIndex·3 + laneIndex`. */
  readonly currentQueuePerChain: readonly number[];
  readonly arms: Readonly<Record<ArmId, ArmMetrics>>;
}

/**
 * Cumulative since-reset summary — the optimizer's ranking input (O1 ranks
 * candidates by mean control delay over the whole rep horizon, not by the
 * trailing window).
 */
export interface RunSummary {
  readonly elapsedSeconds: number;
  readonly tripCount: number;
  readonly meanControlDelaySeconds: number | null;
  readonly meanStoppedSeconds: number | null;
  readonly throughputVehPerHour: number | null;
  /** Monotonic since-reset max of the all-arm queue total (spillback signal). */
  readonly maxQueueCars: number;
  readonly maxQueuePerChain: readonly number[];
}

export interface MetricsEngineOptions {
  /** Rolling window length in sim-seconds (default 180; must be > 0). */
  readonly windowSeconds?: number;
}

/**
 * What the engine observes per tick: the post-step car store plus the tick
 * boundary. `CarWorld` satisfies this structurally (`store`, `tick`, `time`
 * — all advanced by `world.step`); synthetic harnesses may pass a literal.
 */
export interface MetricsWorldView {
  readonly store: CarStore;
  readonly tick: number;
  readonly time: number;
}

/**
 * Minimal departure shape — the F6 seam. The world's `DepartureRecord`
 * names its departure time `timeSeconds`; F6's joined `TripRecord` names it
 * `departTimeSeconds`. Both are accepted (exactly one must be present); the
 * engine keys on entityId only — route data comes from its own observation
 * of the store.
 */
export interface MetricsDeparture {
  readonly entityId: number;
  readonly timeSeconds?: number;
  readonly departTimeSeconds?: number;
}
