/**
 * Scale + tick math tests (task U3 acceptance): nice-number tick selection,
 * autoscale bounds including the empty / all-zero / flat / negative-range
 * edges R3 pinned, mm:ss x-tick selection, and label formatters.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_Y_SCALE,
  autoscaleY,
  formatMMSS,
  formatNumber,
  formatSecondsDisplay,
  niceStep,
  timeTicks,
  ticksInRange,
  trimDecimalZeros,
} from './scale';

describe('niceStep — 1/2/5 × 10ⁿ tick steps', () => {
  it('rounds raw steps up to the next nice number', () => {
    expect(niceStep(36)).toBe(50);
    expect(niceStep(2)).toBe(2);
    expect(niceStep(1.856)).toBe(2);
    expect(niceStep(0.4)).toBe(0.5);
    expect(niceStep(0.3)).toBe(0.5);
    expect(niceStep(100)).toBe(100);
  });

  it('honors the minimum step and exact decade boundaries', () => {
    expect(niceStep(0.05, 0.1)).toBe(0.1);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(10)).toBe(10);
    expect(niceStep(500)).toBe(500);
  });

  it('throws-free on degenerate magnitudes (clamped to minStep)', () => {
    expect(niceStep(0, 0.1)).toBe(0.1);
    // Negative raw steps are treated by magnitude.
    expect(niceStep(-3, 0.1)).toBe(5);
  });
});

describe('ticksInRange — exact integer multiples of the step', () => {
  it('covers the range inclusively', () => {
    expect(ticksInRange(0, 2, 0.5)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(ticksInRange(10, 12, 0.5)).toEqual([10, 10.5, 11, 11.5, 12]);
    expect(ticksInRange(-2, 1, 1)).toEqual([-2, -1, 0, 1]);
  });

  it('survives float fuzz at the boundaries (-0 normalized)', () => {
    // 0.30000000000000004 / 0.1 must land on the 0.3 tick, not skip it.
    const up = ticksInRange(0.30000000000000004, 0.30000000000000004, 0.1);
    expect(up.length).toBe(1);
    expect(up[0]).toBeCloseTo(0.3, 12);
    const down = ticksInRange(0, 0.29999999999999993, 0.1);
    expect(down.length).toBeGreaterThanOrEqual(3);
    down.forEach((tick, i) => expect(tick).toBeCloseTo(i * 0.1, 9));
    // No negative zero sneaks into tick arrays.
    expect(Object.is(ticksInRange(0, 2, 0.5)[0], -0)).toBe(false);
  });

  it('empty when the step is non-positive', () => {
    expect(ticksInRange(0, 1, 0)).toEqual([]);
  });
});

describe('autoscaleY — bounds incl. the empty/zero-range edges (R3)', () => {
  it('empty and all-null series use the readable default', () => {
    expect(autoscaleY([])).toEqual(EMPTY_Y_SCALE);
    expect(autoscaleY([null, null])).toEqual(EMPTY_Y_SCALE);
    expect(EMPTY_Y_SCALE.ticks[0]).toBe(0);
    expect(EMPTY_Y_SCALE.min).toBeLessThan(EMPTY_Y_SCALE.max);
  });

  it('all-zero series clamps to the minimum range [0, 2] with 0.5 ticks', () => {
    const scale = autoscaleY([0, 0, 0]);
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(2);
    expect(scale.ticks).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('flat non-zero series centers the min-range window on the value', () => {
    const scale = autoscaleY([12, 12, 12]);
    expect(scale.min).toBe(10);
    expect(scale.max).toBe(12);
    expect(scale.ticks[0]).toBe(10);
    expect(scale.ticks[scale.ticks.length - 1]).toBe(12);
  });

  it('flat negative series keeps a window around the value (delay may dip < 0)', () => {
    const scale = autoscaleY([-0.5, -0.1]);
    expect(scale.min).toBeLessThanOrEqual(-0.5);
    expect(scale.max).toBeGreaterThanOrEqual(-0.1);
    expect(scale.max).toBeGreaterThan(0); // zero stays visible
  });

  it('pads ±8% and extends outward to nice-tick boundaries', () => {
    const scale = autoscaleY([0, 8]);
    expect(scale.min).toBeLessThanOrEqual(-0.64);
    expect(scale.max).toBeGreaterThanOrEqual(8.64);
    // Everything on the tick grid, first/last tick == bounds.
    const step = (scale.ticks[1] as number) - (scale.ticks[0] as number);
    for (const tick of scale.ticks) {
      expect(Math.abs((tick - (scale.ticks[0] as number)) / step) % 1).toBeCloseTo(0, 9);
    }
    expect(scale.ticks[0]).toBeCloseTo(scale.min, 9);
    expect(scale.ticks[scale.ticks.length - 1]).toBeCloseTo(scale.max, 9);
  });

  it('nulls are skipped, not treated as zero', () => {
    const withNulls = autoscaleY([null, 4, null, 8, null]);
    const without = autoscaleY([4, 8]);
    expect(withNulls).toEqual(without);
  });
});

describe('timeTicks — mm:ss x ticks over a fixed window', () => {
  it('180 s window: 60 s steps from sim-time 0', () => {
    expect(timeTicks(0, 180, 4)).toEqual([0, 60, 120, 180]);
  });

  it('scrolled window stays aligned to round sim times', () => {
    expect(timeTicks(120, 300, 4)).toEqual([120, 180, 240, 300]);
  });

  it('short windows step down to 5 s', () => {
    expect(timeTicks(0, 20, 4)).toEqual([0, 5, 10, 15, 20]);
  });

  it('never exceeds the target count + 1', () => {
    for (const window of [20, 45, 90, 180, 300, 900]) {
      const ticks = timeTicks(0, window, 4);
      expect(ticks.length).toBeLessThanOrEqual(5);
      expect(ticks[0]).toBeGreaterThanOrEqual(0);
      expect(ticks[ticks.length - 1] as number).toBeLessThanOrEqual(window);
    }
  });
});

describe('formatters', () => {
  it('trimDecimalZeros', () => {
    expect(trimDecimalZeros('2.50')).toBe('2.5');
    expect(trimDecimalZeros('3.00')).toBe('3');
    expect(trimDecimalZeros('3')).toBe('3');
    expect(trimDecimalZeros('0.50')).toBe('0.5');
    expect(trimDecimalZeros('12.05')).toBe('12.05');
  });

  it('formatNumber trims and dashes null/non-finite', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatNumber(12.34, 1)).toBe('12.3');
    expect(formatNumber(12, 1)).toBe('12');
    expect(formatNumber(-1.5, 1)).toBe('-1.5');
  });

  it('formatSecondsDisplay appends the unit', () => {
    expect(formatSecondsDisplay(12.34)).toBe('12.3 s');
    expect(formatSecondsDisplay(null)).toBe('—');
  });

  it('formatMMSS — m:ss with zero padding, negatives clamp', () => {
    expect(formatMMSS(0)).toBe('0:00');
    expect(formatMMSS(65)).toBe('1:05');
    expect(formatMMSS(185)).toBe('3:05');
    expect(formatMMSS(600)).toBe('10:00');
    expect(formatMMSS(-3)).toBe('0:00');
  });
});
