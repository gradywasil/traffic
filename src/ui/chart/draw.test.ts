/**
 * Chart draw-list tests (task U3 acceptance): deterministic rendering —
 * the same input (value for value) always yields the exact same command
 * list — plus the empty-series placeholder, gap handling, all-zero autoscale
 * bounds, axis label coverage, and the fixed x window.
 */
import { describe, expect, it } from 'vitest';
import type { DrawCommand } from '../../render/drawlist';
import type { TimePoint } from './chart-state';
import { CHART_EMPTY_MESSAGE, CHART_LINE_COLOR, buildChartFrame, chartXWindow } from './draw';

function texts(commands: readonly DrawCommand[]): string[] {
  return commands.filter((c): c is Extract<DrawCommand, { kind: 'text' }> => c.kind === 'text').map((c) => c.text);
}

function seriesPolylines(commands: readonly DrawCommand[]): readonly { x: number; y: number }[][] {
  return commands
    .filter((c) => c.kind === 'strokePolyline' && c.color === CHART_LINE_COLOR)
    .map((c) => (c as Extract<DrawCommand, { kind: 'strokePolyline' }>).points.map((p) => ({ x: p.x, y: p.y })));
}

function pointsOf(values: readonly (number | null)[]): TimePoint[] {
  return values.map((v, i) => ({ t: i, v }));
}

describe('chartXWindow — fixed x window', () => {
  it('early run anchors at 0 and spans a full window', () => {
    expect(chartXWindow(45, 180)).toEqual({ min: 0, max: 180 });
  });

  it('once past the window it rolls with now', () => {
    expect(chartXWindow(300, 180)).toEqual({ min: 120, max: 300 });
    expect(chartXWindow(180, 180)).toEqual({ min: 0, max: 180 });
    const rolling = chartXWindow(180.1, 180);
    expect(rolling.max).toBeCloseTo(180.1, 9);
    expect(rolling.min).toBeCloseTo(0.1, 9);
  });
});

describe('buildChartFrame — determinism', () => {
  const input = {
    points: [
      { t: 0, v: 1.5 },
      { t: 1, v: 3.25 },
      { t: 2, v: null },
      { t: 3, v: 2 },
      { t: 4, v: 4.75 },
    ],
    timeSeconds: 4,
    windowSeconds: 10,
    widthPx: 640,
    heightPx: 120,
  };

  it('identical inputs (fresh object identities) produce identical draw lists', () => {
    const first = buildChartFrame(input);
    const second = buildChartFrame({
      points: input.points.map((p) => ({ t: p.t, v: p.v })),
      timeSeconds: 4,
      windowSeconds: 10,
      widthPx: 640,
      heightPx: 120,
    });
    expect(first).toEqual(second);
    // And repeated pure calls are stable.
    expect(buildChartFrame(input)).toEqual(first);
  });

  it('different data produces a different list', () => {
    const base = buildChartFrame(input);
    // Past the window the x anchor rolls — a visibly different frame.
    const scrolled = buildChartFrame({ ...input, timeSeconds: 12 });
    expect(scrolled).not.toEqual(base);
    const rescaled = buildChartFrame({
      ...input,
      points: input.points.map((p) => ({ t: p.t, v: p.v === null ? null : p.v * 3 })),
    });
    expect(rescaled).not.toEqual(base);
  });
});

describe('buildChartFrame — structure', () => {
  it('empty series: placeholder text, gridlines, no line, no head dot', () => {
    const commands = buildChartFrame({
      points: [],
      timeSeconds: 0,
      windowSeconds: 180,
      widthPx: 640,
      heightPx: 120,
    });
    expect(texts(commands)).toContain(CHART_EMPTY_MESSAGE);
    expect(seriesPolylines(commands)).toEqual([]);
    // Gridlines + labels for the default [0, 10] scale and the x window.
    expect(texts(commands)).toContain('0:00');
    expect(texts(commands)).toContain('3:00');
    expect(texts(commands)).toContain('10');
    // No head dot when there is no non-null sample.
    expect(commands.some((c) => c.kind === 'fillCircle' && c.color === CHART_LINE_COLOR)).toBe(false);
  });

  it('all-null series (no trips yet) also draws the placeholder', () => {
    const commands = buildChartFrame({
      points: pointsOf([null, null, null, null]),
      timeSeconds: 4,
      windowSeconds: 10,
      widthPx: 640,
      heightPx: 120,
    });
    expect(texts(commands)).toContain(CHART_EMPTY_MESSAGE);
    expect(seriesPolylines(commands)).toEqual([]);
  });

  it('all-zero series draws a flat line inside the clamped [0, 2] scale', () => {
    const commands = buildChartFrame({
      points: pointsOf([0, 0, 0, 0]),
      timeSeconds: 3,
      windowSeconds: 10,
      widthPx: 640,
      heightPx: 120,
    });
    expect(texts(commands)).not.toContain(CHART_EMPTY_MESSAGE);
    const lines = seriesPolylines(commands);
    expect(lines.length).toBe(1);
    expect((lines[0] as { x: number; y: number }[]).length).toBe(4);
    for (const point of lines[0] as { x: number; y: number }[]) {
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(120);
    }
    // The y axis shows the min-range clamp: a '2' gridline label exists.
    expect(texts(commands)).toContain('2');
    // Head dot on the latest sample.
    expect(commands.some((c) => c.kind === 'fillCircle' && c.color === CHART_LINE_COLOR)).toBe(true);
  });

  it('null gaps break the line into runs', () => {
    const commands = buildChartFrame({
      points: pointsOf([1, 1, null, 1, 1]),
      timeSeconds: 4,
      windowSeconds: 10,
      widthPx: 640,
      heightPx: 120,
    });
    const lines = seriesPolylines(commands);
    expect(lines.length).toBe(2);
    expect((lines[0] as { x: number; y: number }[]).length).toBe(2);
    expect((lines[1] as { x: number; y: number }[]).length).toBe(2);
  });

  it('negative dips stay in frame (delay may be slightly negative)', () => {
    const commands = buildChartFrame({
      points: pointsOf([-0.5, -0.2, -0.4]),
      timeSeconds: 2,
      windowSeconds: 10,
      widthPx: 640,
      heightPx: 120,
    });
    const lines = seriesPolylines(commands);
    expect(lines.length).toBe(1);
    for (const point of lines[0] as { x: number; y: number }[]) {
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(120);
    }
  });

  it('x labels are round mm:ss times for a 180 s window', () => {
    const commands = buildChartFrame({
      points: pointsOf([1, 2, 3]),
      timeSeconds: 180,
      windowSeconds: 180,
      widthPx: 900,
      heightPx: 110,
    });
    const labels = texts(commands);
    expect(labels).toContain('0:00');
    expect(labels).toContain('1:00');
    expect(labels).toContain('2:00');
    expect(labels).toContain('3:00');
  });

  it('single-point series draws the head dot but no line', () => {
    const commands = buildChartFrame({
      points: [{ t: 0, v: 3 }],
      timeSeconds: 0,
      windowSeconds: 180,
      widthPx: 640,
      heightPx: 120,
    });
    expect(seriesPolylines(commands)).toEqual([]);
    expect(commands.some((c) => c.kind === 'fillCircle' && c.color === CHART_LINE_COLOR)).toBe(true);
  });
});
