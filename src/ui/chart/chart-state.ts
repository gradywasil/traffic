/**
 * Chart state (task U3): the pure data core of the rolling avg-wait chart —
 * a sim-time-keyed ring buffer with window trim (research R3) fed through a
 * `SimTimeGate`, so the series only ever advances at 1 s sim-time boundaries
 * (the tested throttle: per-frame cost is one float compare; a push happens
 * at most once per sample interval). No DOM, no canvas, no clocks — the draw
 * list is derived from `series()` by `draw.ts`, deterministically.
 *
 * The state knows nothing about metrics: `frame(time, value)` takes whatever
 * scalar the caller is charting (the app wires
 * `snapshot.meanControlDelaySeconds`); null values are legal and draw as
 * gaps ("no completed trips yet" right after a stats reset).
 */
import { SimTimeGate } from './gate';

/** One charted sample: sim time and the windowed value (null = gap). */
export interface TimePoint {
  readonly t: number;
  readonly v: number | null;
}

/** Default sampling interval: one sample per simulated second ("~1 Hz"). */
export const DEFAULT_CHART_SAMPLE_INTERVAL_SECONDS = 1;

/**
 * Bounded, sim-time-keyed sample buffer (R3's "ring buffer + window trim"):
 * strictly increasing timestamps, capacity-capped, trimmed against the
 * rolling window's left edge. Array-backed — at window 180 s × 1 sample/s
 * the shift-on-trim cost is invisible at this cadence.
 */
export class TimeSeriesRing {
  private readonly samples: TimePoint[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!(capacity >= 2) || !Number.isFinite(capacity)) {
      throw new Error(`ring capacity must be >= 2, got ${String(capacity)}`);
    }
    this.capacity = Math.ceil(capacity);
  }

  /** Append a sample; non-advancing timestamps are ignored (sim time only moves forward). */
  push(timeSeconds: number, value: number | null): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && timeSeconds <= last.t) return;
    this.samples.push({ t: timeSeconds, v: value });
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Drop samples strictly older than `minTimeSeconds` (the window's left edge). */
  trimBefore(minTimeSeconds: number): void {
    for (;;) {
      const first = this.samples[0];
      if (first === undefined || first.t >= minTimeSeconds) break;
      this.samples.shift();
    }
  }

  points(): readonly TimePoint[] {
    return this.samples;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export interface ChartStateOptions {
  /** Rolling x window in sim-seconds (must match the metrics window). */
  readonly windowSeconds: number;
  /** Sample interval in sim-seconds (default 1 → one sample per sim-second). */
  readonly sampleIntervalSeconds?: number;
}

/**
 * Gate + ring wired together: `frame` observes (sim time, value) once per
 * rendered frame and returns true exactly when a new sample was recorded —
 * the signal to redraw. Everything else is a no-op float compare.
 */
export class ChartState {
  readonly windowSeconds: number;
  readonly sampleIntervalSeconds: number;

  private readonly gate: SimTimeGate;
  private readonly ring: TimeSeriesRing;
  private lastSampleTimeState: number | null = null;

  constructor(options: ChartStateOptions) {
    this.windowSeconds = options.windowSeconds;
    this.sampleIntervalSeconds = options.sampleIntervalSeconds ?? DEFAULT_CHART_SAMPLE_INTERVAL_SECONDS;
    if (!(this.windowSeconds > 0) || !Number.isFinite(this.windowSeconds)) {
      throw new Error(`chart window must be finite > 0 s, got ${String(options.windowSeconds)}`);
    }
    if (!(this.sampleIntervalSeconds > 0) || !Number.isFinite(this.sampleIntervalSeconds)) {
      throw new Error(`chart sample interval must be finite > 0 s, got ${String(options.sampleIntervalSeconds)}`);
    }
    this.gate = new SimTimeGate(this.sampleIntervalSeconds);
    this.ring = new TimeSeriesRing(Math.ceil(this.windowSeconds / this.sampleIntervalSeconds) + 2);
  }

  /** Observe the current sim time + windowed value; true when the series advanced. */
  frame(timeSeconds: number, value: number | null): boolean {
    if (!this.gate.crossed(timeSeconds)) return false;
    this.ring.push(timeSeconds, value);
    this.ring.trimBefore(timeSeconds - this.windowSeconds);
    this.lastSampleTimeState = timeSeconds;
    return true;
  }

  /** Stats-reset signal (config change): clear history; next frame re-anchors. */
  reset(): void {
    this.gate.reset();
    this.ring.clear();
    this.lastSampleTimeState = null;
  }

  /** In-window samples, oldest first (empty right after construction/reset). */
  series(): readonly TimePoint[] {
    return this.ring.points();
  }

  get lastSampleTime(): number | null {
    return this.lastSampleTimeState;
  }
}
