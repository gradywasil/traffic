/**
 * Metrics chart view (task U3): DOM + canvas wiring around the pure chart
 * core. Owns three things:
 *
 * 1. The canvas line chart of the rolling mean control delay ("average
 *    wait") — samples taken at 1 s sim-time boundaries via `ChartState` (the
 *    gate is the whole per-frame cost: one float compare outside the gate),
 *    redrawn ONLY when the series advances, on window resize, and when the
 *    tab becomes visible again (a long-hidden backing store repaints).
 * 2. The headline text readout (current avg wait + throughput) as REAL DOM
 *    text — the accessibility stance's "live stats exposed as text"
 *    (town-hall §MVP.9); updated on the same ~1 Hz cadence, never per frame.
 * 3. The stats-reset response: `reset()` clears the history (config changes
 *    reset the metrics window — comparisons stay clean, town-hall §MVP.7).
 *
 * The view consumes `MetricsSnapshot`s only — no simulation knowledge; the
 * draw list comes from the pure `buildChartFrame` and is painted by the
 * shared U1 painter on the DPR-aware canvas (research R3's shared utility).
 */
import { configureCanvasDPR, paintFrame } from '../../render/painter';
import type { MetricsSnapshot } from '../../sim/metrics/types';
import { DEFAULT_METRICS_WINDOW_SECONDS } from '../../sim/metrics/constants';
import { ChartState } from './chart-state';
import type { TimePoint } from './chart-state';
import { DEFAULT_CHART_SAMPLE_INTERVAL_SECONDS } from './chart-state';
import { buildChartFrame } from './draw';
import { formatMMSS, formatNumber } from './scale';

/** Fallback logical size before the element gets a laid-out CSS box. */
const CHART_FALLBACK_WIDTH_PX = 300;
const CHART_FALLBACK_HEIGHT_PX = 120;

export interface MetricsChartOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  /** Rolling window in sim-seconds (default: F7's default metrics window). */
  readonly windowSeconds?: number;
  /** Sample interval in sim-seconds (default 1 → ~1 Hz at 1× speed). */
  readonly sampleIntervalSeconds?: number;
}

/** The headline text readout values for one snapshot (pure — binding-tested). */
export interface HeadlineTexts {
  readonly avgWait: string;
  readonly throughput: string;
  readonly detail: string;
}

/** Format the headline readout (pure; the DOM layer only assigns these strings). */
export function headlineTexts(snapshot: MetricsSnapshot): HeadlineTexts {
  const wait = snapshot.meanControlDelaySeconds;
  const throughput = snapshot.throughputVehPerHour;
  return {
    avgWait: wait === null ? '—' : `${formatNumber(wait, 1)} s`,
    throughput: throughput === null ? '—' : `${String(Math.round(throughput))} veh/h`,
    detail: `${String(snapshot.tripCount)} trips in window · max queue ${String(snapshot.maxQueueCars)} · since reset ${formatMMSS(snapshot.elapsedSinceResetSeconds)}`,
  };
}

export class MetricsChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly state: ChartState;
  private readonly handleResize = (): void => {
    this.resize();
  };
  private readonly handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.redraw();
  };

  private ctx: CanvasRenderingContext2D;
  private snapshot: MetricsSnapshot | null = null;
  private readonly avgWaitOut: HTMLElement;
  private readonly throughputOut: HTMLElement;
  private readonly detailOut: HTMLElement;

  constructor(options: MetricsChartOptions) {
    this.canvas = options.canvas;
    this.state = new ChartState({
      windowSeconds: options.windowSeconds ?? DEFAULT_METRICS_WINDOW_SECONDS,
      sampleIntervalSeconds: options.sampleIntervalSeconds ?? DEFAULT_CHART_SAMPLE_INTERVAL_SECONDS,
    });
    this.ctx = configureCanvasDPR(this.canvas, CHART_FALLBACK_WIDTH_PX, CHART_FALLBACK_HEIGHT_PX);

    // Headline DOM: real text elements, labeled for screen readers.
    const root = options.container;
    root.textContent = '';
    root.className = 'headline-stats';
    const makeStat = (labelText: string): HTMLElement => {
      const stat = document.createElement('span');
      stat.className = 'stat';
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = labelText;
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = '—';
      stat.append(label, value);
      root.append(stat);
      return value;
    };
    this.avgWaitOut = makeStat('Avg wait (control delay)');
    this.throughputOut = makeStat('Throughput');
    this.detailOut = makeStat('Window');

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  /**
   * Per-frame hook: gate-checks sim time; redraws (chart canvas + headline
   * text) only when the series advanced (≤ once per sample interval of sim
   * time — ~1 Hz at 1×). The snapshot is provided by the caller; nothing is
   * read from the simulation here.
   */
  frame(snapshot: MetricsSnapshot): void {
    this.snapshot = snapshot;
    if (this.state.frame(snapshot.timeSeconds, snapshot.meanControlDelaySeconds)) this.redraw();
  }

  /** Stats-reset signal (config change): clear history and repaint empty. */
  reset(): void {
    this.state.reset();
    this.redraw();
  }

  /** Current in-window samples (diagnostics/tests). */
  series(): readonly TimePoint[] {
    return this.state.series();
  }

  private resize(): void {
    this.ctx = configureCanvasDPR(this.canvas, CHART_FALLBACK_WIDTH_PX, CHART_FALLBACK_HEIGHT_PX);
    this.redraw();
  }

  private redraw(): void {
    const snapshot = this.snapshot;
    if (snapshot === null) return;
    // Sync the backing store if the laid-out CSS box changed since the last
    // configure (first layout, resize without an event, browser zoom).
    const cssWidth = this.canvas.clientWidth || CHART_FALLBACK_WIDTH_PX;
    const cssHeight = this.canvas.clientHeight || CHART_FALLBACK_HEIGHT_PX;
    const dpr = window.devicePixelRatio ?? 1;
    if (
      this.canvas.width !== Math.max(1, Math.round(cssWidth * dpr)) ||
      this.canvas.height !== Math.max(1, Math.round(cssHeight * dpr))
    ) {
      this.ctx = configureCanvasDPR(this.canvas, CHART_FALLBACK_WIDTH_PX, CHART_FALLBACK_HEIGHT_PX);
    }
    const commands = buildChartFrame({
      points: this.state.series(),
      timeSeconds: snapshot.timeSeconds,
      windowSeconds: this.state.windowSeconds,
      widthPx: cssWidth,
      heightPx: cssHeight,
    });
    paintFrame(this.ctx, commands);
    const texts = headlineTexts(snapshot);
    this.avgWaitOut.textContent = texts.avgWait;
    this.throughputOut.textContent = texts.throughput;
    this.detailOut.textContent = texts.detail;
  }
}
