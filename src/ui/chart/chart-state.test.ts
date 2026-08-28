/**
 * Chart-state tests (task U3 acceptance): the ~1 Hz gating logic (chart
 * state advances ONLY at sample-interval boundaries — the throttle), the
 * sim-time ring buffer's window trim, reset semantics, and state
 * determinism (same input sequence ⇒ same series).
 */
import { describe, expect, it } from 'vitest';
import { ChartState } from './chart-state';
import { SimTimeGate } from './gate';
import { TimeSeriesRing } from './chart-state';

describe('SimTimeGate — sim-time throttle', () => {
  it('first call crosses; same-interval calls do not; boundaries cross', () => {
    const gate = new SimTimeGate(1);
    expect(gate.crossed(0)).toBe(true);
    expect(gate.crossed(0.5)).toBe(false);
    expect(gate.crossed(0.9)).toBe(false);
    expect(gate.crossed(1.0)).toBe(true);
    expect(gate.crossed(1.9)).toBe(false);
    expect(gate.crossed(2.0)).toBe(true);
  });

  it('honors a custom interval', () => {
    const gate = new SimTimeGate(2);
    expect(gate.crossed(0)).toBe(true);
    expect(gate.crossed(1.9)).toBe(false);
    expect(gate.crossed(2.0)).toBe(true);
  });

  it('non-monotonic sim time (world reset) is itself a boundary', () => {
    const gate = new SimTimeGate(1);
    gate.crossed(2);
    expect(gate.crossed(300)).toBe(true);
    expect(gate.crossed(0)).toBe(true);
  });

  it('reset() makes the next observation cross again', () => {
    const gate = new SimTimeGate(1);
    gate.crossed(5);
    expect(gate.crossed(5.4)).toBe(false);
    gate.reset();
    expect(gate.crossed(5.5)).toBe(true);
  });

  it('rejects invalid intervals', () => {
    expect(() => new SimTimeGate(0)).toThrow();
    expect(() => new SimTimeGate(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('TimeSeriesRing', () => {
  it('keeps strictly increasing samples only', () => {
    const ring = new TimeSeriesRing(8);
    ring.push(1, 10);
    ring.push(1, 11); // same time: ignored
    ring.push(0.5, 9); // backwards: ignored
    ring.push(2, 12);
    expect(ring.points().map((p) => p.t)).toEqual([1, 2]);
    expect(ring.points()[1]?.v).toBe(12);
  });

  it('capacity caps the buffer (oldest dropped)', () => {
    const ring = new TimeSeriesRing(3);
    for (let t = 0; t < 10; t += 1) ring.push(t, t * 2);
    expect(ring.points().map((p) => p.t)).toEqual([7, 8, 9]);
  });

  it('trimBefore drops strictly older samples', () => {
    const ring = new TimeSeriesRing(16);
    for (let t = 0; t <= 6; t += 1) ring.push(t, null);
    ring.trimBefore(3);
    expect(ring.points().map((p) => p.t)).toEqual([3, 4, 5, 6]);
    ring.clear();
    expect(ring.points()).toEqual([]);
  });

  it('rejects bad capacity', () => {
    expect(() => new TimeSeriesRing(1)).toThrow();
    expect(() => new TimeSeriesRing(Number.NaN)).toThrow();
  });
});

describe('ChartState — the ~1 Hz advance throttle', () => {
  it('state advances only at whole-second sim-time boundaries (dt = 0.1 feed)', () => {
    const state = new ChartState({ windowSeconds: 10 });
    const advancedAt: number[] = [];
    for (let tick = 0; tick <= 30; tick += 1) {
      const t = tick * 0.1;
      if (state.frame(t, t * 2)) advancedAt.push(t);
    }
    expect(advancedAt).toEqual([0, 1, 2, 3]);
    expect(state.series().map((p) => p.t)).toEqual([0, 1, 2, 3]);
    expect(state.series().map((p) => p.v)).toEqual([0, 2, 4, 6]);
    expect(state.lastSampleTime).toBe(3);
  });

  it('paused sim time (repeated frames) never advances the state', () => {
    const state = new ChartState({ windowSeconds: 10 });
    state.frame(2.4, 7);
    expect(state.series().map((p) => p.t)).toEqual([2.4]);
    expect(state.frame(2.4, 7)).toBe(false);
    expect(state.frame(2.4, 7)).toBe(false);
    expect(state.series().map((p) => p.t)).toEqual([2.4]); // unchanged
  });

  it('faster playback still takes exactly one sample per simulated second', () => {
    // 4x speed: sim time advances ~0.4 s per rendered frame. Samples land at
    // the FIRST observation past each 1 s boundary (so up to one frame late),
    // never more than one per boundary — the count is speed-independent.
    const fast = new ChartState({ windowSeconds: 30 });
    let fastTime = 0;
    for (let frame = 0; frame < 25; frame += 1) {
      fast.frame(fastTime, fastTime);
      fastTime += 0.4;
    }
    const times = fast.series().map((p) => p.t);
    expect(times.length).toBe(10); // one per simulated second in [0, 10)
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i += 1) {
      const gap = (times[i] as number) - (times[i - 1] as number);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(1.4); // ≤ interval + one 4x frame step
    }
  });

  it('window trim keeps only in-window samples', () => {
    const state = new ChartState({ windowSeconds: 3 });
    for (let tick = 0; tick <= 60; tick += 1) {
      const t = tick * 0.1;
      state.frame(t, t);
    }
    expect(state.series().map((p) => p.t)).toEqual([3, 4, 5, 6]);
  });

  it('reset clears history; the next frame re-anchors immediately', () => {
    const state = new ChartState({ windowSeconds: 10 });
    state.frame(1.0, 5);
    state.frame(2.0, 6);
    state.reset();
    expect(state.series()).toEqual([]);
    expect(state.lastSampleTime).toBeNull();
    // Mid-interval after a reset still crosses (re-anchor draw).
    expect(state.frame(2.5, 6)).toBe(true);
    expect(state.series().map((p) => p.t)).toEqual([2.5]);
  });

  it('null values (no trips yet) are legal samples', () => {
    const state = new ChartState({ windowSeconds: 10 });
    state.frame(0, null);
    state.frame(1, null);
    expect(state.series().map((p) => p.v)).toEqual([null, null]);
  });

  it('determinism: identical input sequences produce identical series', () => {
    const run = (): string => {
      const state = new ChartState({ windowSeconds: 30 });
      for (let tick = 0; tick <= 500; tick += 1) {
        const t = tick * 0.1;
        state.frame(t, tick % 3 === 0 ? null : Math.sin(t) * 10);
      }
      return JSON.stringify(state.series());
    };
    expect(run()).toBe(run());
  });

  it('rejects invalid windows / intervals', () => {
    expect(() => new ChartState({ windowSeconds: 0 })).toThrow();
    expect(() => new ChartState({ windowSeconds: 10, sampleIntervalSeconds: 0 })).toThrow();
  });
});
