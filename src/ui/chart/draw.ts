/**
 * Chart draw list (task U3, research R3): builds the rolling avg-wait line
 * chart as a pure `DrawCommand[]` in CSS-pixel coordinates — the same
 * command vocabulary and dumb painter the U1 world renderer uses, so
 * rendering stays deterministic (same input ⇒ same draw list, unit-tested)
 * and the chart inherits the shared DPR handling for free.
 *
 * Chart semantics (R3 + town-hall §MVP.4):
 * - Fixed x window of `windowSeconds` ending at max(window, now): the early
 *   run anchors at 0 and fills from the left; mm:ss ticks at nice steps.
 * - Y autoscale with nice ticks and a min-range clamp (see scale.ts); the
 *   line breaks across null samples (no completed trips in that second).
 * - No scrubbing, no hover, no zoom (town-hall decision #7) — read-only.
 */
import type { Vec2 } from '../../geom';
import type { DrawCommand } from '../../render/drawlist';
import {
  ACCENT,
  CANVAS_BACKDROP,
  CHART_GRID,
  TEXT_DIM,
  TEXT_PRIMARY,
} from '../styles/palette';
import type { TimePoint } from './chart-state';
import { autoscaleY, formatMMSS, formatNumber, timeTicks } from './scale';

// --- palette (D1: bound to the centralized palette module — see
//     src/ui/styles/palette.ts for the contrast numbers) ----------------------
export const CHART_BG_COLOR = CANVAS_BACKDROP;
export const CHART_GRID_COLOR = CHART_GRID;
export const CHART_TEXT_DIM_COLOR = TEXT_DIM;
export const CHART_TITLE_COLOR = TEXT_PRIMARY;
export const CHART_LINE_COLOR = ACCENT;

// --- layout constants (CSS px) ----------------------------------------------
const MARGIN_LEFT_PX = 44;
const MARGIN_RIGHT_PX = 10;
const MARGIN_TOP_PX = 20;
const MARGIN_BOTTOM_PX = 18;
// D1 legibility: data line 1.6 → 1.8 px and head dot 2.6 → 3.0 so the series
// stays dominant over the (deliberately faint) gridlines at the 110 px-tall
// layout size; gridline color moved #232a36 → #384359 (1.3:1 → 2.0:1) —
// visible as reference, subordinate to the 9.1:1 line.
const LINE_WIDTH_PX = 1.8;
const HEAD_DOT_RADIUS_PX = 3.0;
const FONT_PX = 11;
const TITLE_FONT_PX = 12;
const X_TICK_TARGET = 4;

export const CHART_EMPTY_MESSAGE = 'waiting for completed trips…';

export interface ChartFrameInput {
  /** In-window samples, oldest first (null values draw as gaps). */
  readonly points: readonly TimePoint[];
  /** "Now" in sim seconds — the x window's right anchor. */
  readonly timeSeconds: number;
  /** Rolling x window length in sim seconds (> 0). */
  readonly windowSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** X window: [max(window, now) − window, max(window, now)] (early run anchored at 0). */
export function chartXWindow(timeSeconds: number, windowSeconds: number): { min: number; max: number } {
  const max = Math.max(windowSeconds, timeSeconds);
  return { min: max - windowSeconds, max };
}

/**
 * Build the chart's draw list. Pure: floor/ceil/min/max arithmetic on the
 * input only — identical inputs produce identical command arrays (value for
 * value), which is the determinism contract the unit tests pin.
 */
export function buildChartFrame(input: ChartFrameInput): readonly DrawCommand[] {
  const width = Math.max(120, input.widthPx);
  const height = Math.max(80, input.heightPx);
  const plotX = MARGIN_LEFT_PX;
  const plotY = MARGIN_TOP_PX;
  const plotW = Math.max(10, width - MARGIN_LEFT_PX - MARGIN_RIGHT_PX);
  const plotH = Math.max(10, height - MARGIN_TOP_PX - MARGIN_BOTTOM_PX);
  const commands: DrawCommand[] = [];

  // Backdrop.
  commands.push({
    kind: 'fillPolygon',
    layer: 'background',
    points: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    color: CHART_BG_COLOR,
  });

  // Title.
  commands.push({
    kind: 'text',
    layer: 'hud',
    x: MARGIN_LEFT_PX,
    y: 4,
    text: `Average wait — control delay (s), last ${formatMMSS(input.windowSeconds)}`,
    color: CHART_TITLE_COLOR,
    fontPx: TITLE_FONT_PX,
  });

  // Scales.
  const xWindow = chartXWindow(input.timeSeconds, input.windowSeconds);
  const xSpan = xWindow.max - xWindow.min; // > 0: windowSeconds > 0
  const yScale = autoscaleY(input.points.map((p) => p.v));
  const ySpan = yScale.max - yScale.min; // > 0: autoscale guarantees it
  const xOf = (t: number): number => plotX + ((t - xWindow.min) / xSpan) * plotW;
  const yOf = (v: number): number => plotY + plotH - ((v - yScale.min) / ySpan) * plotH;

  // Horizontal gridlines + y labels (right-aligned into the left margin).
  for (const tick of yScale.ticks) {
    const y = yOf(tick);
    commands.push({
      kind: 'strokePolyline',
      layer: 'background',
      points: [
        { x: plotX, y },
        { x: plotX + plotW, y },
      ],
      color: CHART_GRID_COLOR,
      widthPx: 1,
    });
    commands.push({
      kind: 'text',
      layer: 'hud',
      x: plotX - 6,
      y: y - FONT_PX * 0.35,
      text: formatNumber(tick, ySpan < 3 ? 1 : 0),
      color: CHART_TEXT_DIM_COLOR,
      fontPx: FONT_PX,
      align: 'right',
    });
  }

  // Vertical gridlines + mm:ss x labels (centered under the axis).
  for (const tick of timeTicks(xWindow.min, xWindow.max, X_TICK_TARGET)) {
    const x = xOf(tick);
    commands.push({
      kind: 'strokePolyline',
      layer: 'background',
      points: [
        { x, y: plotY },
        { x, y: plotY + plotH },
      ],
      color: CHART_GRID_COLOR,
      widthPx: 1,
    });
    commands.push({
      kind: 'text',
      layer: 'hud',
      x,
      y: plotY + plotH + 4,
      text: formatMMSS(tick),
      color: CHART_TEXT_DIM_COLOR,
      fontPx: FONT_PX,
      align: 'center',
    });
  }

  // Series: one polyline per run of consecutive non-null samples (null = gap).
  let run: Vec2[] = [];
  const flushRun = (): void => {
    if (run.length >= 2) {
      commands.push({
        kind: 'strokePolyline',
        layer: 'hud',
        points: run,
        color: CHART_LINE_COLOR,
        widthPx: LINE_WIDTH_PX,
      });
    }
    run = [];
  };
  let head: Vec2 | null = null;
  for (const point of input.points) {
    if (point.v === null) {
      flushRun();
      continue;
    }
    const px: Vec2 = { x: xOf(point.t), y: yOf(point.v) };
    run.push(px);
    head = px;
  }
  flushRun();

  if (head === null) {
    commands.push({
      kind: 'text',
      layer: 'hud',
      x: plotX + plotW / 2,
      y: plotY + plotH / 2 - FONT_PX * 0.35,
      text: CHART_EMPTY_MESSAGE,
      color: CHART_TEXT_DIM_COLOR,
      fontPx: FONT_PX,
      align: 'center',
    });
    return commands;
  }

  // Current-value head dot (the chart's only "live" marker; no scrubbing).
  commands.push({
    kind: 'fillCircle',
    layer: 'hud',
    x: head.x,
    y: head.y,
    radiusPx: HEAD_DOT_RADIUS_PX,
    color: CHART_LINE_COLOR,
  });
  return commands;
}
