/**
 * Stress-config guarantees (task Q2): the load floor the acceptance bar
 * measures against is only honest if it is GUARANTEED, not hoped for —
 * these tests pin (a) validity through the production validator, and
 * (b) ≥ 150 concurrent cars reached and HELD by the real pipeline
 * (SimRuntime + real spawner, spillback included).
 */
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config';
import { SimRuntime } from '../../src/ui/sim-runtime';
import { STRESS_TARGET_CONCURRENT_CARS, STRESS_WARMUP_TICKS, createStressConfig } from './stress-config';

describe('Q2 stress config', () => {
  it('passes the production validator with zero issues', () => {
    const issues = validateConfig(createStressConfig());
    expect(issues).toEqual([]);
  });

  it('is a fresh mutable object per call (no shared frozen state)', () => {
    const a = createStressConfig();
    const b = createStressConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    // Deep-fresh: nothing is aliased between two calls.
    expect(a.arms.north).not.toBe(b.arms.north);
    expect(a.arms.north.lanes).not.toBe(b.arms.north.lanes);
    expect(a.control).not.toBe(b.control);
    expect(Object.isFrozen(a)).toBe(false);
  });

  it(
    `holds >= ${String(STRESS_TARGET_CONCURRENT_CARS)} concurrent cars through every post-warmup tick`,
    { timeout: 60_000 },
    () => {
      const runtime = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
      // Warmup: fill the approaches (dips BELOW the floor are expected while
      // queues build — the guarantee is about the measurement window after it).
      for (let tick = 1; tick <= STRESS_WARMUP_TICKS; tick += 1) runtime.step();
      expect(runtime.world.store.count).toBeGreaterThanOrEqual(STRESS_TARGET_CONCURRENT_CARS);
      // Measurement window: the floor must hold EVERY tick — a benchmark that
      // samples any 10 s window post-warmup sees ≥150 concurrent cars.
      let min = Number.POSITIVE_INFINITY;
      let peak = 0;
      for (let tick = 1; tick <= 1500; tick += 1) {
        runtime.step();
        const alive = runtime.world.store.count;
        if (alive < min) min = alive;
        if (alive > peak) peak = alive;
      }
      expect(min).toBeGreaterThanOrEqual(STRESS_TARGET_CONCURRENT_CARS);
      expect(peak).toBeGreaterThanOrEqual(STRESS_TARGET_CONCURRENT_CARS);
      // Real oversaturation, not just a full lot: spillback engaged.
      expect(runtime.spawner.stats.maxVirtualQueueDepth).toBeGreaterThan(0);
      // Deterministic construction: same seed ⇒ same alive trajectory.
      const rerun = new SimRuntime(createStressConfig(), { masterSeed: 1, capacity: 512 });
      for (let tick = 1; tick <= STRESS_WARMUP_TICKS + 1500; tick += 1) rerun.step();
      expect(rerun.world.store.count).toBe(runtime.world.store.count);
    },
  );
});
