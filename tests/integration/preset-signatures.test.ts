/**
 * Q1 preset delay signatures — town-hall §"Success measures": "Three presets
 * produce visibly distinct chart signatures." Integration form: each preset
 * runs the full pipeline to a FIXED horizon over a FIXED seed set; the
 * cumulative mean control delay (the headline metric the chart plots as its
 * rolling mean) must separate the presets with clear margins.
 *
 * Horizon and seed-set choice (measured 2026-08-27, this machine):
 * - HORIZON 120 s (1200 ticks on the 0.1 s grid), SEEDS 1..8 (8 reps each).
 *   At 120 s every seed separates DISJOINTLY: per-seed mean delay ranges
 *   light [8.8, 18.8] s < balanced [21.6, 29.5] s < gridlock [33.3, 40.2] s
 *   (gaps 2.8 / 3.8 s); means 14.8 / 25.7 / 36.4 s (margins 10.9 / 10.6 s).
 * - Longer horizons grow the light preset's episodic permissive-left blocking
 *   variance until per-seed ranges overlap (measured: 150 s light seed 8 hits
 *   31.2 s vs balanced min 26.7 s; 200 s overlaps widely) — so the signature
 *   horizon is pinned where the separation is clean at every seed.
 * - 8 reps × 3 presets × 1200 ticks ≈ 3-4 s wall — enough seeds to show the
 *   separation is not a single-realization artifact, cheap enough for CI.
 *
 * Because the sim is deterministic, these are fixed measurements (not
 * samples): the seed set demonstrates robustness ACROSS demand realizations;
 * every value below re-measures identically on re-run.
 *
 * Secondary discriminators asserted (measured ranges):
 * - mean stopped-time: light [4.4, 13.4] < balanced [14.9, 21.8] < gridlock [25.5, 30.7] s (disjoint);
 * - since-reset max queue: gridlock [44, 60] cars, strictly above balanced [15, 30] and light [3, 20];
 * - spillback (max virtual entry-queue depth): every gridlock rep ≥ 10 vs balanced ≤ 6 —
 *   only the oversaturated preset spills demand back out of the world.
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../src/config';
import { getPreset } from '../../src/presets';
import { runPipeline } from './support/pipeline';
import type { PipelineResult } from './support/pipeline';

const HORIZON_TICKS = 1200; // 120 s
const SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];
/** Clear-margin bar for mean-of-reps separation (measured margins ≈ 10.6+). */
const MEAN_MARGIN_SECONDS = 5;

interface PresetMeasures {
  readonly id: string;
  readonly meanDelays: readonly number[];
  readonly meanStopped: readonly number[];
  readonly maxQueues: readonly number[];
  readonly maxVirtualQueues: readonly number[];
  readonly trips: readonly number[];
}

function measure(id: 'light' | 'balanced' | 'gridlock-risk', config: IntersectionConfig): PresetMeasures {
  const meanDelays: number[] = [];
  const meanStopped: number[] = [];
  const maxQueues: number[] = [];
  const maxVirtualQueues: number[] = [];
  const trips: number[] = [];
  for (const seed of SEEDS) {
    const result: PipelineResult = runPipeline({ config, masterSeed: seed, ticks: HORIZON_TICKS });
    expect(result.tripsCompleted, `${id} seed ${String(seed)}: real traffic`).toBeGreaterThanOrEqual(10);
    const delay = result.runSummary.meanControlDelaySeconds;
    const stopped = result.runSummary.meanStoppedSeconds;
    if (delay === null || stopped === null) throw new Error(`${id} seed ${String(seed)}: no trips completed`);
    meanDelays.push(delay);
    meanStopped.push(stopped);
    maxQueues.push(result.runSummary.maxQueueCars);
    maxVirtualQueues.push(result.maxVirtualQueueDepth);
    trips.push(result.tripsCompleted);
  }
  return { id, meanDelays, meanStopped, maxQueues, maxVirtualQueues, trips };
}

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const maxOf = (values: readonly number[]): number => Math.max(...values);
const minOf = (values: readonly number[]): number => Math.min(...values);

describe('Q1 preset delay signatures: light < balanced < gridlock-risk, clear margins', () => {
  it(
    `mean control delay separates all three presets (${String(HORIZON_TICKS)} ticks × ${String(SEEDS.length)} seeds)`,
    { timeout: 120_000 },
    () => {
      const light = measure('light', getPreset('light').config);
      const balanced = measure('balanced', getPreset('balanced').config);
      const gridlock = measure('gridlock-risk', getPreset('gridlock-risk').config);

      console.info(
        `[signatures] meanDelay per seed — light [${minOf(light.meanDelays).toFixed(1)}, ${maxOf(light.meanDelays).toFixed(1)}] ` +
          `(mean ${mean(light.meanDelays).toFixed(1)}), balanced [${minOf(balanced.meanDelays).toFixed(1)}, ${maxOf(balanced.meanDelays).toFixed(1)}] ` +
          `(mean ${mean(balanced.meanDelays).toFixed(1)}), gridlock [${minOf(gridlock.meanDelays).toFixed(1)}, ${maxOf(gridlock.meanDelays).toFixed(1)}] ` +
          `(mean ${mean(gridlock.meanDelays).toFixed(1)}); meanStopped — light [${minOf(light.meanStopped).toFixed(1)}, ${maxOf(light.meanStopped).toFixed(1)}], ` +
          `balanced [${minOf(balanced.meanStopped).toFixed(1)}, ${maxOf(balanced.meanStopped).toFixed(1)}], ` +
          `gridlock [${minOf(gridlock.meanStopped).toFixed(1)}, ${maxOf(gridlock.meanStopped).toFixed(1)}]; ` +
          `maxQueue — light [${String(minOf(light.maxQueues))}, ${String(maxOf(light.maxQueues))}], ` +
          `balanced [${String(minOf(balanced.maxQueues))}, ${String(maxOf(balanced.maxQueues))}], ` +
          `gridlock [${String(minOf(gridlock.maxQueues))}, ${String(maxOf(gridlock.maxQueues))}]; ` +
          `spillback vq — light [${String(minOf(light.maxVirtualQueues))}, ${String(maxOf(light.maxVirtualQueues))}], ` +
          `balanced [${String(minOf(balanced.maxVirtualQueues))}, ${String(maxOf(balanced.maxVirtualQueues))}], ` +
          `gridlock [${String(minOf(gridlock.maxVirtualQueues))}, ${String(maxOf(gridlock.maxVirtualQueues))}]`,
      );

      // Primary: mean-of-reps separation with clear margins.
      expect(mean(gridlock.meanDelays) - mean(balanced.meanDelays), 'gridlock − balanced mean delay').toBeGreaterThan(
        MEAN_MARGIN_SECONDS,
      );
      expect(mean(balanced.meanDelays) - mean(light.meanDelays), 'balanced − light mean delay').toBeGreaterThan(
        MEAN_MARGIN_SECONDS,
      );

      // Stronger: per-seed ranges are DISJOINT (every demand realization separates).
      expect(maxOf(light.meanDelays), 'light max < balanced min').toBeLessThan(minOf(balanced.meanDelays));
      expect(maxOf(balanced.meanDelays), 'balanced max < gridlock min').toBeLessThan(minOf(gridlock.meanDelays));

      // Secondary signatures.
      expect(maxOf(light.meanStopped), 'stopped-time: light max < balanced min').toBeLessThan(
        minOf(balanced.meanStopped),
      );
      expect(maxOf(balanced.meanStopped), 'stopped-time: balanced max < gridlock min').toBeLessThan(
        minOf(gridlock.meanStopped),
      );
      expect(minOf(gridlock.maxQueues), 'max queue: gridlock above balanced').toBeGreaterThan(
        maxOf(balanced.maxQueues),
      );
      // Spillback exists only on the oversaturated preset.
      expect(minOf(gridlock.maxVirtualQueues), 'gridlock spillback above balanced').toBeGreaterThan(
        maxOf(balanced.maxVirtualQueues),
      );
      expect(maxOf(light.maxVirtualQueues), 'light never spills far').toBeLessThanOrEqual(
        maxOf(balanced.maxVirtualQueues),
      );
    },
  );
});
