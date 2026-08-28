/**
 * Engineering overlay model (task U3): the pure, DOM-free view model behind
 * the thin engineering overlay (town-hall §MVP.5 — control delay, stopped
 * time, throughput, max queue, model-parameter read-out; read-only, no new
 * inputs). `buildOverlayModel` copies values STRAIGHT out of the metrics
 * snapshot — never recomputes, never rounds in the model (rounding is a
 * display concern, done by the exported formatters) — so overlay numbers
 * equal the metrics-engine fixture values exactly (unit-tested against F7
 * hand-computable fixtures).
 *
 * Model-parameter read-out: `IntersectionConfig.modelParams` (the R1 §3.1
 * Guarded-IDM block) plus dt and lane width, verbatim from the config.
 *
 * Honesty caveat surfaced here (R1 §6.1): during full-arm spillback the zone
 * delay saturates while queues grow without bound — the queue columns are
 * the unbounded signal; the DOM panel carries this note.
 */
import { ARM_IDS } from '../../config';
import type { ArmId, IntersectionConfig, ModelParams } from '../../config';
import type { MetricsSnapshot } from '../../sim/metrics/types';
import type { ArmMetrics } from '../../sim/metrics/types';
import { formatMMSS, formatNumber } from '../chart/scale';

export interface OverlayLabelValue {
  readonly label: string;
  readonly value: string;
}

export interface OverlayArmRow {
  readonly arm: ArmId;
  /** Snapshot values, verbatim (null = no completed trips on the arm). */
  readonly meanControlDelaySeconds: number | null;
  readonly meanStoppedSeconds: number | null;
  readonly throughputVehPerHour: number | null;
  readonly maxQueueCars: number;
  readonly maxQueuePerLane: readonly number[];
  /** Display strings (from the exported formatters — test-pinned). */
  readonly delayText: string;
  readonly stoppedText: string;
  readonly throughputText: string;
  readonly queueText: string;
  readonly queuePerLaneText: string;
  /** Bar width 0..1 relative to the busiest arm (≤ 0 when unsizable). */
  readonly barFraction: number;
}

export interface OverlayModel {
  readonly summary: readonly OverlayLabelValue[];
  readonly arms: readonly OverlayArmRow[];
  /** The per-arm bar scale denominator (max arm mean delay; > 0 when bars size). */
  readonly barMaxSeconds: number;
  readonly params: readonly OverlayLabelValue[];
}

// --- display formatters (pure, unit-test-pinned) -----------------------------

/** Delay/stopped seconds at FIXED 2 decimals ("18.00 s" — column-aligned engineering readout); null → '—'. */
export function formatDelaySeconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} s`;
}

/** Throughput rounded to whole veh/h; null → '—'. */
export function formatThroughput(value: number | null): string {
  return value === null ? '—' : `${String(Math.round(value))} veh/h`;
}

/** Per-lane max queue, lane 0 (leftmost) first: "7 / 5 / 0". */
export function formatQueuePerLane(lanes: readonly number[]): string {
  return lanes.map((q) => String(q)).join(' / ');
}

/** Model parameter value at 2 decimals with trailing zeros trimmed. */
export function formatParamValue(value: number): string {
  return formatNumber(value, 2);
}

/** The ModelParams read-out rows (labels follow the R1 §3.1 notation). */
export function modelParamRows(params: ModelParams): readonly OverlayLabelValue[] {
  return [
    { label: 'Cruise speed v_c', value: `${formatParamValue(params.cruiseSpeedMps)} m/s` },
    { label: 'Time headway T', value: `${formatParamValue(params.timeHeadwaySeconds)} s` },
    { label: 'Max accel a', value: `${formatParamValue(params.maxAccelerationMps2)} m/s²` },
    { label: 'Comfortable decel b', value: `${formatParamValue(params.comfortableDecelMps2)} m/s²` },
    { label: 'Emergency decel b_e', value: `${formatParamValue(params.emergencyDecelMps2)} m/s²` },
    { label: 'Min gap s0', value: `${formatParamValue(params.minGapMeters)} m` },
    { label: 'Hard min gap s_min', value: `${formatParamValue(params.hardMinGapMeters)} m` },
    { label: 'Accel exponent δ', value: formatParamValue(params.accelerationExponent) },
    { label: 'Car length', value: `${formatParamValue(params.carLengthMeters)} m` },
    { label: 'Lateral accel a_lat', value: `${formatParamValue(params.lateralAccelMps2)} m/s²` },
    { label: 'Yellow reaction t_r', value: `${formatParamValue(params.yellowReactionSeconds)} s` },
    { label: 'Yellow decel a_y', value: `${formatParamValue(params.yellowDecelMps2)} m/s²` },
  ];
}

function armRow(arm: ArmId, metrics: ArmMetrics, barMax: number): OverlayArmRow {
  const fraction =
    metrics.meanControlDelaySeconds !== null && barMax > 0
      ? Math.min(1, Math.max(0, metrics.meanControlDelaySeconds / barMax))
      : 0;
  return {
    arm,
    meanControlDelaySeconds: metrics.meanControlDelaySeconds,
    meanStoppedSeconds: metrics.meanStoppedSeconds,
    throughputVehPerHour: metrics.throughputVehPerHour,
    maxQueueCars: metrics.maxQueueCars,
    maxQueuePerLane: metrics.maxQueuePerLane,
    delayText: formatDelaySeconds(metrics.meanControlDelaySeconds),
    stoppedText: formatDelaySeconds(metrics.meanStoppedSeconds),
    throughputText: formatThroughput(metrics.throughputVehPerHour),
    queueText: String(metrics.maxQueueCars),
    queuePerLaneText: formatQueuePerLane(metrics.maxQueuePerLane),
    barFraction: fraction,
  };
}

/**
 * Build the overlay view model: every numeric field copied verbatim from the
 * snapshot; every display string produced by the exported formatters. Pure —
 * same snapshot ⇒ same model, value for value.
 */
export function buildOverlayModel(snapshot: MetricsSnapshot, config: IntersectionConfig): OverlayModel {
  const armMetrics: readonly ArmMetrics[] = ARM_IDS.map((arm) => snapshot.arms[arm]);
  const barMaxSeconds = Math.max(
    0,
    ...armMetrics.map((metrics) => metrics.meanControlDelaySeconds ?? Number.NEGATIVE_INFINITY),
  );
  const barMax = Number.isFinite(barMaxSeconds) ? barMaxSeconds : 0;

  return {
    summary: [
      { label: 'Mean control delay', value: formatDelaySeconds(snapshot.meanControlDelaySeconds) },
      { label: 'p50', value: formatDelaySeconds(snapshot.controlDelayP50Seconds) },
      { label: 'p85', value: formatDelaySeconds(snapshot.controlDelayP85Seconds) },
      { label: 'p95', value: formatDelaySeconds(snapshot.controlDelayP95Seconds) },
      { label: 'Mean stopped time', value: formatDelaySeconds(snapshot.meanStoppedSeconds) },
      { label: 'Throughput (all arms)', value: formatThroughput(snapshot.throughputVehPerHour) },
      { label: 'Max queue (all arms)', value: String(snapshot.maxQueueCars) },
      { label: 'Trips in window', value: String(snapshot.tripCount) },
      { label: 'Window', value: formatMMSS(snapshot.windowSeconds) },
      { label: 'Since reset', value: formatMMSS(snapshot.elapsedSinceResetSeconds) },
    ],
    arms: ARM_IDS.map((arm, index) => armRow(arm, armMetrics[index] ?? snapshot.arms[arm], barMax)),
    barMaxSeconds: barMax,
    params: [
      ...modelParamRows(config.modelParams),
      { label: 'Simulation dt', value: `${formatParamValue(config.dt)} s` },
      { label: 'Lane width', value: `${formatParamValue(config.geometry.laneWidthMeters)} m` },
    ],
  };
}
