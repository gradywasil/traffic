/**
 * Q1 integration no-overlap soak — town-hall §"Success measures": "No visual
 * car overlap at any time". The F5 soak assertions, lifted to integration
 * level: the REAL spawner (F6, seeded sfc32 sub-streams), the REAL control
 * arbitration, the REAL world + metrics — the full `SimRuntime` pipeline,
 * 10,000 ticks (1000 sim-s) per config across all three control regimes
 * (signal 2-phase permissive / signal 4-phase protected ×2 demand levels /
 * all-way stop).
 *
 * Every tick, every car pair: F3 capsule-model footprint distance
 * (AABB-pruned) must stay ≥ CAR_WIDTH_METERS (zero intersections), the
 * Guarded-IDM terminal clamp must never fire, and no car may cross a stop
 * line without a grant. Every run is hashed (Q1 integration run-hash) and a
 * second identical run is diffed — R2 Part C's Q1 recipe: "soak (≥10k ticks,
 * ≥3 configs) hashes every run and diffs".
 */
import { describe, expect, it } from 'vitest';
import type { IntersectionConfig } from '../../src/config';
import { CAR_WIDTH_METERS } from '../../src/geom';
import { getPreset } from '../../src/presets';
import { runPipeline } from './support/pipeline';
import type { PipelineResult } from './support/pipeline';

const OVERLAP_EPS = 1e-7;
const TICKS = 10_000;

function allWayStopConfig(): IntersectionConfig {
  return { ...getPreset('light').config, control: { type: 'all-way-stop' } };
}

interface SoakCase {
  readonly id: string;
  readonly config: IntersectionConfig;
  /** Distinct seed per mode (randomized soaks; F5 soak seed set). */
  readonly seed: number;
  /** Real-flow floor: completed trips over 1000 s (measured, -30% headroom). */
  readonly minTrips: number;
}

const CASES: readonly SoakCase[] = [
  { id: 'signal 2-phase permissive (light preset)', config: getPreset('light').config, seed: 90210, minTrips: 100 },
  { id: 'signal 4-phase protected (balanced preset)', config: getPreset('balanced').config, seed: 424242, minTrips: 250 },
  { id: 'signal 4-phase protected, oversaturated (gridlock-risk preset)', config: getPreset('gridlock-risk').config, seed: 7777, minTrips: 250 },
  { id: 'all-way stop (light geometry)', config: allWayStopConfig(), seed: 31337, minTrips: 80 },
];

function expectCleanSoak(result: PipelineResult, label: string, minTrips: number): void {
  expect(result.overlapCount, `${label}: footprint intersections`).toBe(0);
  expect(result.minFootprintDistance, `${label}: min footprint distance`).toBeGreaterThanOrEqual(
    CAR_WIDTH_METERS - OVERLAP_EPS,
  );
  expect(result.clampCount, `${label}: terminal clamp firings`).toBe(0);
  expect(result.ungrantedLineCrossings, `${label}: ungranted stop-line crossings`).toBe(0);
  expect(result.tripsCompleted, `${label}: completed trips`).toBeGreaterThanOrEqual(minTrips);
  expect(result.peakAlive, `${label}: peak alive (real contention)`).toBeGreaterThanOrEqual(15);
  expect(result.grants, `${label}: claims granted`).toBeGreaterThan(0);
}

describe('Q1 integration soak: zero footprint intersections, full pipeline, real spawner', () => {
  for (const soakCase of CASES) {
    it(
      `${soakCase.id} — ${String(TICKS)} ticks, seeded, hashed + re-run diff`,
      { timeout: 240_000 },
      () => {
        const first = runPipeline({
          config: soakCase.config,
          masterSeed: soakCase.seed,
          ticks: TICKS,
          checkOverlaps: true,
        });
        expectCleanSoak(first, soakCase.id, soakCase.minTrips);

        // Determinism at soak length: same seed + config ⇒ identical hash seq.
        const second = runPipeline({
          config: soakCase.config,
          masterSeed: soakCase.seed,
          ticks: TICKS,
          checkOverlaps: true,
        });
        expectCleanSoak(second, soakCase.id, soakCase.minTrips);
        expect(second.runHash.checkpoints, `${soakCase.id}: hash sequence re-run`).toEqual(
          first.runHash.checkpoints,
        );
        expect(second.runHash.finalHash, `${soakCase.id}: final hash re-run`).toBe(first.runHash.finalHash);
        expect(second.minFootprintDistance, `${soakCase.id}: min distance re-run`).toBe(
          first.minFootprintDistance,
        );
      },
    );
  }
});
