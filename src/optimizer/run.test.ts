/**
 * Headless run harness tests (task O1): tick math, determinism, the
 * pairing identifiers (spawnDigest plan-independent, rep-sensitive) and the
 * run-hash (plan-sensitive).
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, SignalPlanConfig } from '../config';
import { createDefaultConfig } from '../config';
import { getPreset } from '../presets';
import { createHeadlessRun } from './run';
import { executeHeadlessRun } from './run';
import { horizonTicks } from './run';

const HEX_PAIR = /^[0-9a-f]{8}:[0-9a-f]{8}$/;

function withGreens(config: IntersectionConfig, greens: readonly number[]): IntersectionConfig {
  if (config.control.type !== 'signal') throw new Error('withGreens requires a signal config');
  const plan = config.control.plan;
  const phases = plan.phases.map((phase, index) => ({
    kind: phase.kind,
    greenSeconds: greens[index] as number,
  }));
  const nextPlan: SignalPlanConfig = { ...plan, phases };
  return { ...config, control: { type: 'signal', plan: nextPlan } };
}

describe('horizonTicks', () => {
  it('derives ticks from dt (no hardcoded tick counts)', () => {
    expect(horizonTicks(45, 0.1)).toBe(450);
    expect(horizonTicks(45, 0.05)).toBe(900);
    expect(horizonTicks(8, 0.5)).toBe(16);
  });

  it('rejects horizons off the tick grid and non-positive horizons', () => {
    expect(() => horizonTicks(10.05, 0.1)).toThrow(/tick grid/);
    expect(() => horizonTicks(0, 0.1)).toThrow(/finite > 0/);
    expect(() => horizonTicks(10, 0)).toThrow(/finite > 0/);
  });
});

describe('executeHeadlessRun', () => {
  const config = createDefaultConfig(); // 2-phase, C = 60, dt = 0.1

  it('runs exactly the horizon in ticks and produces shaped identifiers', () => {
    // 60 s so several trips complete (empirically the first exit-gate
    // crossing lands ≈ 14 s in on this config — see production-log).
    const result = executeHeadlessRun({ config, masterSeed: 1, repIndex: 0, horizonSeconds: 60 });
    expect(result.ticksRun).toBe(600);
    expect(result.spawnDigestHex).toMatch(HEX_PAIR);
    expect(result.runHash).toMatch(HEX_PAIR);
    // Metrics anchor the window at the first observe (after tick 1), so the
    // summary's elapsed span is the horizon minus one dt.
    expect(result.runSummary.elapsedSeconds).toBeCloseTo(59.9, 6);
    expect(result.runSummary.tripCount).toBeGreaterThan(0);
    expect(result.runSummary.meanControlDelaySeconds).not.toBeNull();
  });

  it('is deterministic: identical request ⇒ bit-identical result', () => {
    const request = { config, masterSeed: 424242, repIndex: 1, horizonSeconds: 10 };
    const a = executeHeadlessRun(request);
    const b = executeHeadlessRun(request);
    expect(a).toEqual(b);
    expect(a.runHash).toBe(b.runHash);
    expect(a.spawnDigestHex).toBe(b.spawnDigestHex);
  });

  it('pairing identifiers: same rep across DIFFERENT signal plans ⇒ identical spawnDigest, different runHash', () => {
    const planA = executeHeadlessRun({ config: withGreens(config, [26, 26]), masterSeed: 99, repIndex: 2, horizonSeconds: 12 });
    const planB = executeHeadlessRun({ config: withGreens(config, [10, 42]), masterSeed: 99, repIndex: 2, horizonSeconds: 12 });
    expect(planA.spawnDigestHex).toBe(planB.spawnDigestHex); // demand shared (F6 state independence, end-to-end)
    expect(planA.runHash).not.toBe(planB.runHash); // the plans genuinely diverge
  });

  it('different reps ⇒ different spawn digests (paired streams are distinct)', () => {
    const rep0 = executeHeadlessRun({ config, masterSeed: 5, repIndex: 0, horizonSeconds: 10 });
    const rep1 = executeHeadlessRun({ config, masterSeed: 5, repIndex: 1, horizonSeconds: 10 });
    expect(rep0.spawnDigestHex).not.toBe(rep1.spawnDigestHex);
    expect(rep0.runHash).not.toBe(rep1.runHash);
  });

  it('rejects invalid configs and off-grid horizons before ticking', () => {
    expect(() => executeHeadlessRun({ config: withGreens(config, [3, 49]), masterSeed: 1, repIndex: 0, horizonSeconds: 5 })).toThrow(
      /invalid/,
    );
    expect(() => executeHeadlessRun({ config, masterSeed: 1, repIndex: 0, horizonSeconds: 10.05 })).toThrow(/tick grid/);
  });

  it('tickBudget caps ticks deterministically (graceful shortening, never pairing loss)', () => {
    const full = executeHeadlessRun({ config, masterSeed: 11, repIndex: 0, horizonSeconds: 12 });
    const capped = executeHeadlessRun({ config, masterSeed: 11, repIndex: 0, horizonSeconds: 12, tickBudget: 55 });
    expect(capped.ticksRun).toBe(55);
    expect(full.ticksRun).toBe(120);
    // The prefix property: the capped run is the full run's prefix (same
    // demand stream over the shared horizon).
    expect(capped.spawnDigestHex).not.toBe(full.spawnDigestHex); // fewer arrivals fired
    const again = executeHeadlessRun({ config, masterSeed: 11, repIndex: 0, horizonSeconds: 12, tickBudget: 55 });
    expect(again).toEqual(capped);
  });
});

describe('createHeadlessRun handle', () => {
  it('steps one tick at a time and finishes once', () => {
    const config = createDefaultConfig();
    const handle = createHeadlessRun({ config, masterSeed: 1, repIndex: 0, horizonSeconds: 1 });
    expect(handle.totalTicks).toBe(10);
    expect(handle.isDone()).toBe(false);
    for (let i = 0; i < 10; i += 1) handle.step();
    expect(handle.isDone()).toBe(true);
    expect(() => handle.step()).toThrow(/horizon/);
    const result = handle.finish();
    expect(result.ticksRun).toBe(10);
    expect(handle.finish()).toBe(result); // idempotent
  });

  it('finish() before the horizon throws (no silent short runs)', () => {
    const handle = createHeadlessRun({ config: getPreset('light').config, masterSeed: 1, repIndex: 0, horizonSeconds: 2 });
    handle.step();
    expect(() => handle.finish()).toThrow(/early/);
  });

  it('chunked stepping is result-identical to a straight run (time-slice seam)', () => {
    const request = { config: getPreset('balanced').config, masterSeed: 31337, repIndex: 1, horizonSeconds: 6 };
    const straight = executeHeadlessRun(request);
    const chunked = createHeadlessRun(request);
    let steps = 0;
    while (!chunked.isDone()) {
      chunked.step();
      steps += 1;
      if (steps % 7 === 0) void Promise.resolve(); // simulates an await boundary
    }
    expect(chunked.finish()).toEqual(straight);
  });
});
