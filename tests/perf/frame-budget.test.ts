/**
 * Frame-budget arithmetic tests (task Q2): the pure math that turns measured
 * costs into headroom claims must itself be verified — the evidence record
 * quotes these numbers, so off-by-one percentiles or wrong worst-case sums
 * would silently corrupt the acceptance story.
 */
import { describe, expect, it } from 'vitest';
import {
  FRAME_BUDGET_MS,
  LONG_FRAME_MS,
  chunkWorstCase,
  formatFrameStats,
  percentile,
  summarizeFrameTimes,
  worstCaseFrame,
} from './frame-budget';

describe('percentile (nearest-rank)', () => {
  it('of a uniform 1..100 sweep matches the rank exactly (0-based index floor(n·p))', () => {
    const values = Array.from({ length: 100 }, (_unused, i) => i + 1);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 0.5)).toBe(51); // index floor(100·0.5) = 50
    expect(percentile(values, 0.95)).toBe(96); // index 95
    expect(percentile(values, 0.99)).toBe(100); // index 99 = max at n=100
    expect(percentile(values, 1)).toBe(100);
  });

  it('is order-independent (input order must not matter)', () => {
    const a = [3, 1, 2];
    const b = [1, 2, 3];
    expect(percentile(a, 0.5)).toBe(percentile(b, 0.5));
  });

  it('rejects empty input and fractions outside [0, 1]', () => {
    expect(() => percentile([], 0.5)).toThrow();
    expect(() => percentile([1], 1.5)).toThrow();
    expect(() => percentile([1], -0.1)).toThrow();
  });
});

describe('chunkWorstCase (time-sliced executor chunk vs frame)', () => {
  it('budget 4 ms + one overshooting tick; headroom is the frame remainder', () => {
    const result = chunkWorstCase({ chunkBudgetMs: 4, perTickMaxMs: 0.3 });
    expect(result.worstCaseMs).toBeCloseTo(4.3, 10);
    expect(result.headroomMs).toBeCloseTo(FRAME_BUDGET_MS - 4.3, 10);
    // ≤ 25.8% of a 60 Hz frame — the documented Q2 arithmetic.
    expect(result.frameFraction).toBeLessThan(0.26);
  });

  it('respects a caller-supplied budget (e.g. 120 Hz displays)', () => {
    const result = chunkWorstCase({ chunkBudgetMs: 4, perTickMaxMs: 0.2 }, 1000 / 120);
    expect(result.frameFraction).toBeCloseTo(4.2 / (1000 / 120), 10);
    expect(result.headroomMs).toBeCloseTo(1000 / 120 - 4.2, 10);
  });
});

describe('worstCaseFrame (additive pessimistic frame)', () => {
  it('sim + chunk + render add up; headroom and pass/fail derive from the budget', () => {
    const summary = worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      chunk: { chunkBudgetMs: 4, perTickMaxMs: 0.3 },
      renderP99Ms: 2.5,
    });
    expect(summary.simMs).toBeCloseTo(0.2, 10);
    expect(summary.chunkMs).toBeCloseTo(4.3, 10);
    expect(summary.renderMs).toBeCloseTo(2.5, 10);
    expect(summary.worstCaseTotalMs).toBeCloseTo(7.0, 10);
    expect(summary.headroomMs).toBeCloseTo(FRAME_BUDGET_MS - 7.0, 10);
    expect(summary.withinBudget).toBe(true); // minHeadroom defaults to 0
    // Explicit headroom bars derive directly: 9.67 ms left passes a 9 ms bar...
    expect(worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      chunk: { chunkBudgetMs: 4, perTickMaxMs: 0.3 },
      renderP99Ms: 2.5,
      minHeadroomMs: 9,
    }).withinBudget).toBe(true);
    // ...and fails a 10 ms one:
    expect(worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      chunk: { chunkBudgetMs: 4, perTickMaxMs: 0.3 },
      renderP99Ms: 2.5,
      minHeadroomMs: 10,
    }).withinBudget).toBe(false);
    // The Q2 "warn < 12 ms headroom" bar applies to the no-sweep frame
    // (sim + render only): 2.7 ms used leaves 13.97 ms — pass...
    expect(worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      renderP99Ms: 2.5,
      minHeadroomMs: 12,
    }).withinBudget).toBe(true);
    // ...but a heavy render pushes it under the same bar:
    expect(worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      renderP99Ms: 5,
      minHeadroomMs: 12,
    }).withinBudget).toBe(false);
  });

  it('no chunk (worker-pool executor) contributes zero sweep cost', () => {
    const summary = worstCaseFrame({
      sim: { perTickMs: 0.2, maxTicksPerFrame: 1 },
      renderP99Ms: 2.5,
    });
    expect(summary.chunkMs).toBe(0);
    expect(summary.worstCaseTotalMs).toBeCloseTo(2.7, 10);
  });

  it('paused sim (0 ticks/frame) contributes zero sim cost', () => {
    const summary = worstCaseFrame({
      sim: { perTickMs: 5, maxTicksPerFrame: 0 },
      renderP99Ms: 1,
    });
    expect(summary.simMs).toBe(0);
  });
});

describe('summarizeFrameTimes', () => {
  it('computes mean/median/percentiles, fps and the long-frame census', () => {
    // 60 frames at 16.0 ms + 4 frames at 40 ms = 64 frames.
    const frames = [...Array<number>(60).fill(16), ...Array<number>(4).fill(40)];
    const stats = summarizeFrameTimes(frames);
    expect(stats.frames).toBe(64);
    expect(stats.minMs).toBe(16);
    expect(stats.maxMs).toBe(40);
    expect(stats.meanMs).toBeCloseTo((60 * 16 + 4 * 40) / 64, 10);
    expect(stats.meanFps).toBeCloseTo(1000 / stats.meanMs, 10);
    expect(stats.p99Fps).toBeCloseTo(25, 10); // 1000/40 — the worst 1% frame
    // Sorted: 60×16 then 4×40; p95 index = floor(64×0.95) = 60 → first 40.
    expect(stats.p95Ms).toBe(40);
    expect(stats.medianMs).toBe(16);
    expect(stats.longFrames).toBe(4); // all four 40 ms frames > LONG_FRAME_MS
    expect(stats.longFrameRatio).toBeCloseTo(4 / 64, 10);
  });

  it('rejects empty input', () => {
    expect(() => summarizeFrameTimes([])).toThrow();
  });

  it('formats a one-line evidence string containing the headline numbers', () => {
    const line = formatFrameStats('steady-1x', summarizeFrameTimes([16, 16, 17, 21, 16]));
    expect(line).toContain('steady-1x');
    expect(line).toContain('fps');
    expect(line).toContain(String(LONG_FRAME_MS));
  });
});

describe('committed constants', () => {
  it('frame budget is 1000/60; long-frame threshold sits between one and two budgets', () => {
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.6667, 3);
    expect(LONG_FRAME_MS).toBeGreaterThan(FRAME_BUDGET_MS);
    expect(LONG_FRAME_MS).toBeLessThan(2 * FRAME_BUDGET_MS);
  });
});
