/**
 * Q1 integration determinism — town-hall §"Success measures": "same seed +
 * config ⇒ identical run". The full pipeline (spawner → control → world →
 * metrics, via `SimRuntime`) runs to a fixed horizon per config; the Q1
 * integration run-hash (support/run-hash.ts — the FULL R2 Part C record)
 * produces a checkpoint sequence every 64 ticks plus a final digest.
 *
 * Covered:
 * - all three presets + one all-way-stop config: same (seed, config) run
 *   twice ⇒ BIT-IDENTICAL hash checkpoint sequences + final hash, AND
 *   identical final metrics snapshots + run summaries (JSON value equality);
 * - adjacent master seed ⇒ different sequence (vacuous-equality guard);
 * - same seed, different preset ⇒ different run hash (config sensitivity);
 * - a mid-run config-change script (live demand change, live plan retarget,
 *   reset-scope control-type swap) replayed identically ⇒ bit-identical
 *   sequence + snapshot, ≠ the unscripted run (the changes have teeth);
 * - cross-check vs O1's sweep-path run hash: identical re-runs are
 *   bit-identical there too (the sweep's determinism at integration level).
 *
 * Horizon 2000 ticks = 200 s: measured ≥ 100 completed trips per run on every
 * config (real traffic through the box), runtime ~0.3–0.6 s per run.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../src/config';
import { getPreset } from '../../src/presets';
import { executeHeadlessRun } from '../../src/optimizer/run';
import { runPipeline } from './support/pipeline';
import type { PipelineResult } from './support/pipeline';

/** Master seed used across the determinism block (adjacent seed = +1). */
const SEED = 20260827;
/** Horizon in ticks (200 s on the presets' 0.1 s grid). */
const TICKS = 2000;

function allWayStopConfig(): IntersectionConfig {
  // Light-preset geometry/demand under all-way stop control (the fourth mode).
  return { ...getPreset('light').config, control: { type: 'all-way-stop' } };
}

interface CaseConfig {
  readonly id: string;
  readonly config: IntersectionConfig;
  /** Real-traffic floor over 2000 ticks (measured 2026-08-27, −20% headroom). */
  readonly minTrips: number;
}

const CASES: readonly CaseConfig[] = [
  { id: 'light', config: getPreset('light').config, minTrips: 28 },
  { id: 'balanced', config: getPreset('balanced').config, minTrips: 48 },
  { id: 'gridlock-risk', config: getPreset('gridlock-risk').config, minTrips: 54 },
  { id: 'all-way-stop', config: allWayStopConfig(), minTrips: 24 },
];

/** Both runs must carry real traffic or bit-identity would be vacuous. */
function expectRealTraffic(result: PipelineResult, label: string, minTrips: number, ticks: number = TICKS): void {
  expect(result.tripsCompleted, `${label} trips completed`).toBeGreaterThanOrEqual(minTrips);
  expect(result.peakAlive, `${label} peak alive`).toBeGreaterThanOrEqual(10);
  expect(result.runHash.checkpoints.length, `${label} checkpoint count`).toBe(Math.floor(ticks / 64));
  expect(result.runHash.completionCount, `${label} hashed completion records`).toBeGreaterThanOrEqual(minTrips);
  expect(result.runHash.quantizedCount, `${label} Q10-quantized floats`).toBeGreaterThan(0);
  expect(result.clampCount, `${label} terminal clamp`).toBe(0);
  expect(result.ungrantedLineCrossings, `${label} ungranted stop-line crossings`).toBe(0);
}

describe('Q1 integration determinism: same seed + config ⇒ identical run', () => {
  for (const testCase of CASES) {
    it(
      `${testCase.id}: two full-pipeline runs are bit-identical (hash sequence + metrics)`,
      { timeout: 120_000 },
      () => {
        const first = runPipeline({ config: testCase.config, masterSeed: SEED, ticks: TICKS });
        const second = runPipeline({ config: testCase.config, masterSeed: SEED, ticks: TICKS });
        expectRealTraffic(first, testCase.id, testCase.minTrips);
        expectRealTraffic(second, testCase.id, testCase.minTrips);

        expect(second.runHash.checkpoints, 'hash checkpoint sequence').toEqual(first.runHash.checkpoints);
        expect(second.runHash.finalHash, 'final run hash').toBe(first.runHash.finalHash);
        expect(second.spawnDigestHex, 'spawn digest (pairing input)').toBe(first.spawnDigestHex);
        expect(JSON.stringify(second.snapshot), 'final metrics snapshot').toBe(JSON.stringify(first.snapshot));
        expect(JSON.stringify(second.runSummary), 'final run summary').toBe(JSON.stringify(first.runSummary));
      },
    );
  }

  it(
    'adjacent master seed ⇒ different run (the equality is not vacuous)',
    { timeout: 120_000 },
    () => {
      for (const testCase of CASES) {
        const base = runPipeline({ config: testCase.config, masterSeed: SEED, ticks: TICKS });
        const adjacent = runPipeline({ config: testCase.config, masterSeed: SEED + 1, ticks: TICKS });
        expectRealTraffic(adjacent, `${testCase.id}+1seed`, testCase.minTrips);
        // Sequences differ, and not only at the final digest: at least one
        // 64-tick checkpoint diverges (trajectory-level, not bookkeeping).
        expect(adjacent.runHash.checkpoints, `${testCase.id} checkpoint sequence`).not.toEqual(base.runHash.checkpoints);
        expect(adjacent.runHash.finalHash, `${testCase.id} final hash`).not.toBe(base.runHash.finalHash);
        expect(adjacent.spawnDigestHex, `${testCase.id} spawn digest`).not.toBe(base.spawnDigestHex);
      }
    },
  );

  it(
    'same seed, different preset ⇒ different run hash (config sensitivity)',
    { timeout: 120_000 },
    () => {
      const results = CASES.map((testCase) =>
        runPipeline({ config: testCase.config, masterSeed: SEED, ticks: TICKS }),
      );
      const hashes = new Set(results.map((result) => result.runHash.finalHash));
      expect(hashes.size, 'four configs, four distinct run hashes').toBe(CASES.length);
      // Across the three PRESETS the demand differs ⇒ the paired spawn
      // realizations differ too. (The all-way-stop case shares light's demand,
      // so its spawn digest legitimately equals light's — the CONTROL differs,
      // which the run-hash set above already proves.)
      const presets = results.slice(0, 3);
      const digests = new Set(presets.map((result) => result.spawnDigestHex));
      expect(digests.size).toBe(3);
    },
  );

  it(
    'mid-run config-change script replays bit-identically (live demand, live plan retarget, reset to all-way stop)',
    { timeout: 180_000 },
    () => {
      const initial = getPreset('balanced').config;
      // Live demand change: rates 550 → 700 veh/h on every arm (arms are frozen
      // singletons — clone before mutating).
      const demandUp: IntersectionConfig = {
        ...initial,
        arms: {
          north: { ...initial.arms.north, spawnRateVehPerHour: 700 },
          east: { ...initial.arms.east, spawnRateVehPerHour: 700 },
          south: { ...initial.arms.south, spawnRateVehPerHour: 700 },
          west: { ...initial.arms.west, spawnRateVehPerHour: 700 },
        },
      };
      // Live plan retarget: 7/15/7/14 → 9/16/8/10 (Σ = 43 greens, cycle 60 kept;
      // validator deviation 0.2 s ≤ 0.5 s tolerance).
      const balancedControl = initial.control;
      if (balancedControl.type !== 'signal') throw new Error('balanced preset must be signalized');
      const plan: IntersectionConfig = {
        ...demandUp,
        control: {
          type: 'signal',
          plan: {
            ...balancedControl.plan,
            phases: [
              { kind: 'ns-protected-left', greenSeconds: 9 },
              { kind: 'ns-through-right', greenSeconds: 16 },
              { kind: 'ew-protected-left', greenSeconds: 8 },
              { kind: 'ew-through-right', greenSeconds: 10 },
            ],
          },
        },
      };
      // Reset-scope change: control-type swap (world rebuilt at the boundary,
      // fresh deterministic run of the new config from the same master seed).
      const toStop: IntersectionConfig = { ...plan, control: { type: 'all-way-stop' } };
      const script = [
        { atTick: 600, config: demandUp },
        { atTick: 1200, config: plan },
        { atTick: 1800, config: toStop },
      ];
      const runScripted = (): PipelineResult =>
        runPipeline({ config: initial, masterSeed: SEED, ticks: TICKS + 400, changes: script });

      const first = runScripted();
      const second = runScripted();
      expect(first.scopes, 'script classifications').toEqual(['live', 'live', 'reset']);
      expectRealTraffic(first, 'scripted', 45, TICKS + 400);

      expect(second.runHash.checkpoints, 'replayed checkpoint sequence').toEqual(first.runHash.checkpoints);
      expect(second.runHash.finalHash, 'replayed final hash').toBe(first.runHash.finalHash);
      expect(JSON.stringify(second.snapshot), 'replayed snapshot').toBe(JSON.stringify(first.snapshot));
      expect(JSON.stringify(second.runSummary), 'replayed run summary').toBe(JSON.stringify(first.runSummary));

      // Teeth: the scripted run differs from the same seed WITHOUT changes.
      const unscripted = runPipeline({ config: initial, masterSeed: SEED, ticks: TICKS + 400 });
      expect(first.runHash.checkpoints).not.toEqual(unscripted.runHash.checkpoints);
      expect(first.runHash.finalHash).not.toBe(unscripted.runHash.finalHash);
    },
  );

  it(
    "O1 sweep-path run hash: identical re-runs bit-identical, adjacent seed differs (cross-check)",
    { timeout: 120_000 },
    () => {
      const config = getPreset('balanced').config;
      const a = executeHeadlessRun({ config, masterSeed: SEED, repIndex: 0, horizonSeconds: 45 });
      const b = executeHeadlessRun({ config, masterSeed: SEED, repIndex: 0, horizonSeconds: 45 });
      expect(b.runHash).toBe(a.runHash);
      expect(b.spawnDigestHex).toBe(a.spawnDigestHex);
      expect(JSON.stringify(b.runSummary)).toBe(JSON.stringify(a.runSummary));
      const c = executeHeadlessRun({ config, masterSeed: SEED + 1, repIndex: 0, horizonSeconds: 45 });
      expect(c.runHash).not.toBe(a.runHash);
      expect(c.spawnDigestHex).not.toBe(a.spawnDigestHex);
    },
  );
});
