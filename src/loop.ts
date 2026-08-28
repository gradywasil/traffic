/**
 * Fixed-timestep loop with interpolated rendering (task F1).
 *
 * The simulation advances ONLY in exact multiples of `fixedDt` (committed:
 * 0.1 s per research R1 — guarded-IDM ballistic integration assumes it).
 * Rendering happens once per animation frame, at the interpolated instant
 * `alpha = accumulator / fixedDt` between the last two simulation states, so
 * motion stays smooth at display refresh rate while the simulation itself is
 * tick-quantized and deterministic.
 *
 * Robustness: frame deltas are clamped to `maxFrameDt` (a background-tab
 * stall or debugger pause cannot flood the sim), and updates per frame are
 * capped with the backlog dropped instead of death-spiraling.
 */

export interface LoopHooks {
  /** Advance the simulation by exactly one fixed step of `fixedDt` seconds. */
  update(fixedDt: number): void;
  /**
   * Draw the world at interpolation factor `alpha` ∈ [0, 1) between the
   * previous and current simulation states. `frameDt` is the clamped
   * wall-clock duration of this frame in seconds (for meters only — never
   * feed this into simulation state).
   */
  render(alpha: number, frameDt: number): void;
}

export interface LoopOptions extends LoopHooks {
  /** Fixed simulation timestep in seconds. Must be > 0. */
  fixedDt: number;
  /**
   * Largest frame delta honored, in seconds. Slower frames are treated as
   * exactly this long. Default 0.25.
   */
  maxFrameDt?: number;
  /**
   * Hard cap on `update` calls per frame (spiral-of-death guard). Any backlog
   * still remaining after the cap is dropped. Default: ceil(maxFrameDt / fixedDt),
   * i.e. exactly enough to catch up one clamped frame; set lower to keep worst-
   * case frame cost bounded on slow machines.
   */
  maxUpdatesPerFrame?: number;
}

export interface FrameResult {
  /** Number of `update` calls made while processing this frame. */
  updates: number;
  /** Interpolation factor passed to `render`, in [0, 1). */
  alpha: number;
  /** Clamped frame duration in seconds (as passed to `render`). */
  frameDt: number;
  /** Simulation time discarded by the per-frame update cap, in seconds. */
  droppedDt: number;
}

const DEFAULT_MAX_FRAME_DT_S = 0.25;

export class FixedTimestepLoop {
  private readonly fixedDtMs: number;
  private readonly maxFrameDtMs: number;
  private readonly maxUpdatesPerFrame: number;
  private readonly update: LoopHooks['update'];
  private readonly render: LoopHooks['render'];

  private lastTimestampMs: number | null = null;
  private accumulatorMs = 0;

  constructor(options: LoopOptions) {
    if (!(options.fixedDt > 0)) {
      throw new Error(`fixedDt must be > 0, got ${String(options.fixedDt)}`);
    }
    this.fixedDtMs = options.fixedDt * 1000;
    this.maxFrameDtMs = (options.maxFrameDt ?? DEFAULT_MAX_FRAME_DT_S) * 1000;
    if (!(this.maxFrameDtMs > 0)) {
      throw new Error(`maxFrameDt must be > 0, got ${String(options.maxFrameDt)}`);
    }
    // Worst-case catch-up after a clamped frame; ceil keeps one spare step.
    const derivedCap = Math.ceil(this.maxFrameDtMs / this.fixedDtMs);
    this.maxUpdatesPerFrame = options.maxUpdatesPerFrame ?? derivedCap;
    if (!Number.isInteger(this.maxUpdatesPerFrame) || this.maxUpdatesPerFrame < 1) {
      throw new Error(
        `maxUpdatesPerFrame must be an integer >= 1, got ${String(options.maxUpdatesPerFrame)}`,
      );
    }
    this.update = options.update;
    this.render = options.render;
  }

  /**
   * Process one animation frame. `timestampMs` is the frame's clock reading
   * in milliseconds (rAF timestamp or a test-supplied value).
   */
  frame(timestampMs: number): FrameResult {
    if (this.lastTimestampMs === null) {
      // First frame: establish the clock, paint the initial state, no update.
      this.lastTimestampMs = timestampMs;
      this.render(0, 0);
      return { updates: 0, alpha: 0, frameDt: 0, droppedDt: 0 };
    }

    let deltaMs = timestampMs - this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    if (deltaMs < 0) deltaMs = 0; // non-monotonic clock: zero-length frame
    if (deltaMs > this.maxFrameDtMs) deltaMs = this.maxFrameDtMs;

    this.accumulatorMs += deltaMs;

    let updates = 0;
    while (this.accumulatorMs >= this.fixedDtMs && updates < this.maxUpdatesPerFrame) {
      this.update(this.fixedDtMs / 1000);
      this.accumulatorMs -= this.fixedDtMs;
      updates += 1;
    }

    let droppedDt = 0;
    if (this.accumulatorMs >= this.fixedDtMs) {
      // Update cap reached with backlog remaining: shed it (no spiral of death).
      droppedDt = this.accumulatorMs / 1000;
      this.accumulatorMs = 0;
    }

    const alpha = this.accumulatorMs / this.fixedDtMs;
    const frameDt = deltaMs / 1000;
    this.render(alpha, frameDt);
    return { updates, alpha, frameDt, droppedDt };
  }
}
