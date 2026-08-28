/**
 * Frame-budget arithmetic (task Q2): the pure math that turns MEASURED
 * per-tick / per-chunk costs into "what fraction of a 16.6 ms frame can the
 * worst case consume" — the acceptance bar's headroom language
 * (plan Q2: "tick+render budget measured (target ≤16.6ms, warn < 12ms
 * headroom)"; O1's carried-over bar: "UI thread stays ≥55fps during sweep").
 *
 * Pure functions only — no clocks, no DOM; both the headless perf tests
 * (node) and the in-browser benchmark page (benchmark.html) consume the SAME
 * arithmetic, so the numbers in the evidence record are computed one way.
 *
 * Model of a frame (main thread, 60 Hz ⇒ 16.67 ms budget):
 *   frame = live-sim updates + executor chunk (if a time-sliced sweep is
 *           running) + draw-list build + rasterization + browser overhead.
 * Worst cases are additive by design — we size the PESSIMISTIC frame, not the
 * average one:
 *   - live sim: `perTickMaxMs × maxTicksPerFrame` (maxUpdatesPerFrame of the
 *     playback loop; 0 when paused, 1 per normal 60 Hz frame at ≤4× speed —
 *     the cap only binds after a clamped stall);
 *   - time-sliced executor chunk: `chunkBudgetMs + perTickMaxMs` (the chunk
 *     loop checks the clock AFTER each tick, so one tick can overshoot);
 *   - render: measured p99 of (draw-list build + paint).
 */

/** The 60 fps frame budget in milliseconds (1000 / 60). */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * A frame is counted "long" (a visible stutter candidate) at this threshold —
 * comfortably above jitter, one budget below "a frame was dropped".
 */
export const LONG_FRAME_MS = 20;

/** Worst-case main-thread slice of ONE executor chunk, in ms. */
export interface ChunkSliceInput {
  /** Executor chunk budget (TimeSlicedExecutor default: 4 ms). */
  readonly chunkBudgetMs: number;
  /** Measured worst-case (max) per-tick cost of a sweep run, ms. */
  readonly perTickMaxMs: number;
}

export interface ChunkSliceResult {
  /** chunkBudget + one overshooting tick. */
  readonly worstCaseMs: number;
  /** worstCaseMs / FRAME_BUDGET_MS. */
  readonly frameFraction: number;
  /** FRAME_BUDGET_MS − worstCaseMs (what remains for sim + render + browser). */
  readonly headroomMs: number;
}

/** Worst-case per-frame cost of the live sim portion, in ms. */
export interface SimSliceInput {
  /** Measured per-tick cost of the FULL pipeline (control→world→spawner→metrics). */
  readonly perTickMs: number;
  /** Update calls per frame (playback loop cap; 0–1 at steady ≤4× speed). */
  readonly maxTicksPerFrame: number;
}

export interface FrameSliceSummary {
  readonly simMs: number;
  readonly chunkMs: number;
  readonly renderMs: number;
  readonly worstCaseTotalMs: number;
  readonly headroomMs: number;
  readonly headroomFractionOfFrame: number;
  /** True when the worst case still fits the budget with `minHeadroomMs` left. */
  readonly withinBudget: boolean;
}

export interface FrameSliceInput {
  readonly sim: SimSliceInput;
  readonly chunk?: ChunkSliceInput | undefined;
  readonly renderP99Ms: number;
  readonly frameBudgetMs?: number | undefined;
  readonly minHeadroomMs?: number | undefined;
}

/** One executor chunk's worst-case bite out of a frame. */
export function chunkWorstCase(input: ChunkSliceInput, frameBudgetMs: number = FRAME_BUDGET_MS): ChunkSliceResult {
  const worstCaseMs = input.chunkBudgetMs + input.perTickMaxMs;
  return {
    worstCaseMs,
    frameFraction: worstCaseMs / frameBudgetMs,
    headroomMs: frameBudgetMs - worstCaseMs,
  };
}

/** Additive worst-case frame: sim + optional sweep chunk + render p99. */
export function worstCaseFrame(input: FrameSliceInput): FrameSliceSummary {
  const budget = input.frameBudgetMs ?? FRAME_BUDGET_MS;
  const minHeadroom = input.minHeadroomMs ?? 0;
  const simMs = input.sim.perTickMs * input.sim.maxTicksPerFrame;
  const chunkMs = input.chunk === undefined ? 0 : chunkWorstCase(input.chunk, budget).worstCaseMs;
  const worstCaseTotalMs = simMs + chunkMs + input.renderP99Ms;
  const headroomMs = budget - worstCaseTotalMs;
  return {
    simMs,
    chunkMs,
    renderMs: input.renderP99Ms,
    worstCaseTotalMs,
    headroomMs,
    headroomFractionOfFrame: headroomMs / budget,
    withinBudget: headroomMs >= minHeadroom,
  };
}

// ---------------------------------------------------------------------------
// Frame-time statistics (rAF intervals)
// ---------------------------------------------------------------------------

export interface FrameTimeStats {
  readonly frames: number;
  /** Mean frame time (ms) — 1000/mean = average fps. */
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly minMs: number;
  /** Frames over LONG_FRAME_MS (stutter candidates). */
  readonly longFrames: number;
  /** longFrames / frames. */
  readonly longFrameRatio: number;
  /** 1000 / meanMs. */
  readonly meanFps: number;
  /** 1000 / p99Ms — the fps the worst 1% of frames deliver. */
  readonly p99Fps: number;
}

/** Ordered-rank percentile (nearest-rank): sorted[floor(n × p)] with p ∈ [0,1]. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('percentile of empty input');
  if (!(fraction >= 0 && fraction <= 1)) throw new Error(`percentile fraction must be ∈ [0, 1], got ${String(fraction)}`);
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] as number;
}

/** Summarize a series of frame times (ms). */
export function summarizeFrameTimes(frameTimesMs: readonly number[]): FrameTimeStats {
  if (frameTimesMs.length === 0) throw new Error('no frames to summarize');
  let sum = 0;
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let longFrames = 0;
  for (const value of frameTimesMs) {
    sum += value;
    if (value > max) max = value;
    if (value < min) min = value;
    if (value > LONG_FRAME_MS) longFrames += 1;
  }
  const meanMs = sum / frameTimesMs.length;
  return {
    frames: frameTimesMs.length,
    meanMs,
    medianMs: percentile(frameTimesMs, 0.5),
    p95Ms: percentile(frameTimesMs, 0.95),
    p99Ms: percentile(frameTimesMs, 0.99),
    maxMs: max,
    minMs: min,
    longFrames,
    longFrameRatio: longFrames / frameTimesMs.length,
    meanFps: 1000 / meanMs,
    p99Fps: 1000 / percentile(frameTimesMs, 0.99),
  };
}

/** Format a FrameTimeStats as a compact one-line evidence string. */
export function formatFrameStats(label: string, stats: FrameTimeStats): string {
  return (
    `${label}: ${String(stats.frames)} frames, mean ${stats.meanFps.toFixed(1)} fps ` +
    `(frame ms mean ${stats.meanMs.toFixed(2)} / median ${stats.medianMs.toFixed(2)} / ` +
    `p95 ${stats.p95Ms.toFixed(2)} / p99 ${stats.p99Ms.toFixed(2)} / max ${stats.maxMs.toFixed(2)}; ` +
    `${String(stats.longFrames)} > ${String(LONG_FRAME_MS)} ms = ${(stats.longFrameRatio * 100).toFixed(1)}%)`
  );
}
