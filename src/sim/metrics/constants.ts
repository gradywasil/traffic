/**
 * Metrics-engine constants (task F7) — research R1 §6.1 committed values.
 */

/**
 * A car counts as STOPPED (stopped-time accumulation) or QUEUED (queue
 * length) when its speed is strictly below this threshold. R1 §6.1 commits
 * "stopped-time (v < 0.5 m/s in zone)"; the same value doubles as the queue
 * membership test so one physical state ("standing still") feeds both
 * aggregates. Deliberately equal to the control layer's
 * `STOPPED_SPEED_MPS` (stop-sign tickets), but pinned separately: the R1
 * §6.1 metric semantics own this number, not the arbitration heuristics.
 *
 * The plan's task contract floated "e.g., speed < 0.1 m/s"; the committed
 * research value (0.5) wins — it also matches the all-way-stop full-stop
 * test the control layer already uses.
 */
export const METRICS_STOPPED_SPEED_MPS = 0.5;

/**
 * Default rolling-window length in sim-seconds ("last few sim-minutes",
 * town-hall §MVP.4). Sim-time based, never wall-clock; configurable via
 * `MetricsEngineOptions.windowSeconds` / `setWindowSeconds`.
 */
export const DEFAULT_METRICS_WINDOW_SECONDS = 180;
