/**
 * Playback control (task U2): pause/play and the 0.5–4× speed multiplier in
 * front of the F1 fixed-timestep loop (town-hall §MVP.7 "pause/play; speed
 * 0.5–4×").
 *
 * Semantics — sim time only, never a clock read inside the simulation:
 * - The controller owns a wall-clock stamp and a VIRTUAL clock. Each frame
 *   contributes `wallDelta × speed` virtual milliseconds to the inner
 *   `FixedTimestepLoop`, which therefore still advances the simulation in
 *   exact multiples of the committed `fixedDt` (R1 §3.1) regardless of speed.
 * - Pausing freezes the virtual clock: no `update` calls fire, rendering
 *   continues (the interpolated alpha simply holds), and unpausing resumes
 *   WITHOUT a catch-up burst (the wall delta accumulated while paused is
 *   consumed one clamped frame at a time, exactly as if the tab had stalled).
 * - Speed changes apply to subsequent frames only; no virtual-time jump.
 * - The frame delta handed to `render` is the REAL clamped wall delta (the
 *   FPS meter must measure rendering cadence, not simulation speed).
 *
 * Pure TypeScript, timestamp-injected — unit-testable in node exactly like
 * `FixedTimestepLoop` (tests assert sim-time behavior: updates per frame at
 * each speed, paused frames produce zero updates, no burst on resume).
 */
import { FixedTimestepLoop } from '../loop';
import type { FrameResult, LoopHooks } from '../loop';

/** The committed speed set (town-hall: 0.5/1/2/4×). */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1;

export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value as number);
}

const DEFAULT_MAX_FRAME_DT_S = 0.25;

export interface PlaybackOptions extends LoopHooks {
  /** Fixed simulation timestep in seconds (must match the world's dt). */
  readonly fixedDt: number;
  /**
   * Largest WALL frame delta honored, in seconds (default 0.25, F1's clamp).
   * The clamp is applied BEFORE speed scaling, so a stalled frame cannot
   * flood the sim even at 4×.
   */
  readonly maxFrameDt?: number;
}

export class PlaybackController {
  private readonly inner: FixedTimestepLoop;
  private readonly maxFrameDtMs: number;
  private readonly renderHook: LoopHooks['render'];

  private lastTimestampMs: number | null = null;
  private virtualMs = 0;
  /** Real (clamped) wall delta of the frame in flight, for the render hook. */
  private pendingFrameDtMs = 0;

  private pausedState = false;
  private speedState: PlaybackSpeed = DEFAULT_PLAYBACK_SPEED;

  constructor(options: PlaybackOptions) {
    const maxFrameDt = options.maxFrameDt ?? DEFAULT_MAX_FRAME_DT_S;
    this.maxFrameDtMs = maxFrameDt * 1000;
    this.renderHook = options.render;
    this.inner = new FixedTimestepLoop({
      fixedDt: options.fixedDt,
      // Virtual deltas can reach maxFrameDt × maxSpeed (the wall clamp above
      // already ran), so the inner clamp is sized to never double-clamp.
      maxFrameDt: maxFrameDt * Math.max(...PLAYBACK_SPEEDS),
      // Enough update slots to drain one fully-scaled clamped frame.
      maxUpdatesPerFrame: Math.ceil((maxFrameDt * Math.max(...PLAYBACK_SPEEDS)) / options.fixedDt),
      update: options.update,
      render: (alpha) => {
        this.renderHook(alpha, this.pendingFrameDtMs / 1000);
      },
    });
  }

  get paused(): boolean {
    return this.pausedState;
  }

  get speed(): PlaybackSpeed {
    return this.speedState;
  }

  setPaused(paused: boolean): void {
    this.pausedState = paused;
  }

  togglePaused(): void {
    this.pausedState = !this.pausedState;
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (!isPlaybackSpeed(speed)) {
      throw new Error(`playback speed must be one of ${PLAYBACK_SPEEDS.join('/')}x, got ${String(speed)}`);
    }
    this.speedState = speed;
  }

  /**
   * Process one animation frame. `timestampMs` is the frame's clock reading
   * (rAF timestamp or a test-supplied value); the result is the inner loop's
   * `FrameResult` (`frameDt` semantics: real clamped wall delta).
   */
  frame(timestampMs: number): FrameResult {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      this.pendingFrameDtMs = 0;
      return this.inner.frame(0);
    }
    let deltaMs = timestampMs - this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    if (deltaMs < 0) deltaMs = 0; // non-monotonic clock: zero-length frame
    if (deltaMs > this.maxFrameDtMs) deltaMs = this.maxFrameDtMs;
    this.pendingFrameDtMs = deltaMs;
    if (!this.pausedState) this.virtualMs += deltaMs * this.speedState;
    return this.inner.frame(this.virtualMs);
  }
}
