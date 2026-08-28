import { describe, expect, it } from 'vitest';
import type { IntersectionConfig, LaneConfig } from '../config';
import { createDefaultConfig } from '../config/defaults';
import { getPreset } from '../presets/presets';
import type { PresetId } from '../presets/presets';
import { entryZoneMeters, exitZoneMeters, turnSpeedMps } from './freeflow';
import { buildMovementPaths, findMovement } from './paths';

const A_LAT = 1.7;
const CRUISE = 13.9;

function presetConfig(id: PresetId): IntersectionConfig {
  return structuredClone(getPreset(id).config);
}

const SHARED: LaneConfig = { designations: ['left', 'through', 'right'] };
const TWO_LANE: LaneConfig[] = [{ designations: ['left'] }, { designations: ['through', 'right'] }];

function withLanes(lanes: readonly LaneConfig[]): IntersectionConfig {
  const base = createDefaultConfig();
  const arm = { ...base.arms.north, lanes };
  return { ...base, arms: { north: arm, east: arm, south: arm, west: arm } };
}

describe('v_t rule (R1 §6.1: v_turn = min(v_c, sqrt(a_lat·R)))', () => {
  it('caps at cruise and handles straight paths', () => {
    expect(turnSpeedMps(CRUISE, A_LAT, null)).toBe(CRUISE);
    expect(turnSpeedMps(CRUISE, A_LAT, 8.75)).toBeCloseTo(Math.sqrt(A_LAT * 8.75), 12);
    expect(turnSpeedMps(CRUISE, A_LAT, 1e6)).toBe(CRUISE);
    // Slow arms never turn faster than they cruise.
    expect(turnSpeedMps(3, A_LAT, 100)).toBe(3);
  });

  it('every preset movement follows the rule from its own radius', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const config = presetConfig(id);
      for (const movement of buildMovementPaths(config)) {
        const expected = turnSpeedMps(
          config.arms[movement.arm].cruiseSpeedMps,
          config.modelParams.lateralAccelMps2,
          movement.turnRadiusMeters,
        );
        expect(movement.turnSpeedMps, `${movement.id} (${id})`).toBeCloseTo(expected, 12);
      }
    }
  });

  it('through paths keep cruise; right turns come out slower than lefts (R1 §6.1)', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    expect(findMovement(movements, 'north', 1, 'through')!.turnSpeedMps).toBeCloseTo(CRUISE, 12);
    const left = findMovement(movements, 'north', 0, 'left')!;
    const right = findMovement(movements, 'north', 1, 'right')!;
    expect(right.turnSpeedMps).toBeLessThan(left.turnSpeedMps);
    expect(left.turnSpeedMps).toBeLessThan(CRUISE);
    // Hand-computed at defaults: R_left = 14.75 → 5.0075; R_right = 7.75 → 3.6298.
    expect(left.turnSpeedMps).toBeCloseTo(Math.sqrt(A_LAT * 14.75), 9);
    expect(right.turnSpeedMps).toBeCloseTo(Math.sqrt(A_LAT * 7.75), 9);
  });
});

describe('influence-zone gates (R1 §6.1: U and D)', () => {
  it('computes U = v_c²/(2b) + v_c·dt + 2 = 51.6925 m at defaults', () => {
    expect(entryZoneMeters(CRUISE, 0.1, 2.0)).toBeCloseTo(51.6925, 10);
    // dt enters linearly (one tick of travel at cruise).
    expect(entryZoneMeters(CRUISE, 0.2, 2.0)).toBeCloseTo(51.6925 + CRUISE * 0.1, 10);
  });

  it('computes D = (v_c² − v_t²)/(2a) + 2: 2 m for through, ~70.7 m for a tight left', () => {
    expect(exitZoneMeters(CRUISE, CRUISE, 1.3)).toBeCloseTo(2, 10);
    const vLeft = Math.sqrt(A_LAT * 14.75);
    expect(exitZoneMeters(CRUISE, vLeft, 1.3)).toBeCloseTo((CRUISE * CRUISE - vLeft * vLeft) / 2.6 + 2, 10);
  });

  it('places gates on the path: entry = stopLine − U > 0, exit = curveEnd + D < length (presets)', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const config = presetConfig(id);
      for (const movement of buildMovementPaths(config)) {
        const U = entryZoneMeters(config.arms[movement.arm].cruiseSpeedMps, config.dt, config.modelParams.comfortableDecelMps2);
        const D = exitZoneMeters(config.arms[movement.arm].cruiseSpeedMps, movement.turnSpeedMps, config.modelParams.maxAccelerationMps2);
        expect(movement.entryGateS, `${movement.id} (${id})`).toBeCloseTo(movement.stopLineS - U, 9);
        expect(movement.exitGateS, `${movement.id} (${id})`).toBeCloseTo(movement.curveEndS + D, 9);
        expect(movement.entryGateS).toBeGreaterThan(0);
        expect(movement.exitGateS).toBeLessThan(movement.lengthMeters);
        expect(movement.influenceZoneMeters).toBeCloseTo(movement.exitGateS - movement.entryGateS, 12);
        expect(movement.influenceZoneMeters).toBeGreaterThan(0);
        // Gate points sit on the path near their s.
        expect(Math.hypot(movement.entryGatePoint.x, movement.entryGatePoint.y)).toBeGreaterThan(0);
      }
    }
  });
});

describe('FF(p) closed form (R1 §6.1)', () => {
  it('through: FF = (U + box + D)/v_c = (51.6925 + 20 + 2)/13.9 ≈ 5.3016 s (balanced, lane 1)', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const through = findMovement(movements, 'north', 1, 'through')!;
    const U = entryZoneMeters(CRUISE, 0.1, 2.0);
    const box = through.curveEndS - through.stopLineS; // 13 + 7 = 20 m
    expect(box).toBeCloseTo(20, 9);
    expect(through.freeFlowSeconds).toBeCloseTo((U + box + 2) / CRUISE, 9);
  });

  it('left: matches an independent re-computation of the canonical trajectory (balanced, lane 0)', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const left = findMovement(movements, 'north', 0, 'left')!;
    const vT = Math.sqrt(A_LAT * 14.75);
    const U = entryZoneMeters(CRUISE, 0.1, 2.0);
    const decelDist = (CRUISE * CRUISE - vT * vT) / 4;
    const mid = left.curveEndS - left.stopLineS; // arc length (chord-accumulated ≈ R·π/2)
    const expected =
      (U - decelDist) / CRUISE +
      (CRUISE - vT) / 2.0 +
      mid / vT +
      (CRUISE - vT) / 1.3 +
      2 / CRUISE;
    expect(left.freeFlowSeconds).toBeCloseTo(expected, 9);
    // The arc length itself is within 0.1% of the analytic quarter circle.
    expect(mid).toBeGreaterThan(14.75 * (Math.PI / 2) * 0.999);
    expect(mid).toBeLessThan(14.75 * (Math.PI / 2));
  });

  it('FF > 0 for every movement of every preset and lane-shape configs', () => {
    const configs: IntersectionConfig[] = [
      presetConfig('light'),
      presetConfig('balanced'),
      presetConfig('gridlock-risk'),
      withLanes([SHARED]),
      withLanes(TWO_LANE),
      withLanes([{ designations: ['left'] }, { designations: ['through'] }, { designations: ['through', 'right'] }]),
      withLanes([{ designations: ['left', 'through', 'right'] }, { designations: ['left', 'through', 'right'] }, { designations: ['left', 'through', 'right'] }]),
    ];
    for (const config of configs) {
      for (const movement of buildMovementPaths(config)) {
        expect(movement.freeFlowSeconds, movement.id).toBeGreaterThan(0);
        expect(Number.isFinite(movement.freeFlowSeconds)).toBe(true);
        // Honesty bound: a free-flow car never beats cruise over the zone.
        expect(movement.freeFlowSeconds).toBeGreaterThanOrEqual(movement.influenceZoneMeters / config.arms[movement.arm].cruiseSpeedMps - 1e-9);
      }
    }
  });

  it('jogged through paths (3 lanes into 1) keep v_t = v_c and a rational FF', () => {
    const config = withLanes([{ designations: ['through'] }, { designations: ['through'] }, { designations: ['through', 'right'] }]);
    const movements = buildMovementPaths(config);
    for (const laneIndex of [0, 1, 2]) {
      const movement = findMovement(movements, 'north', laneIndex, 'through')!;
      expect(movement.turnSpeedMps).toBeCloseTo(CRUISE, 12);
      expect(movement.freeFlowSeconds).toBeGreaterThan(0);
      // FF ≈ (zone length)/v_c since v_t = v_c throughout.
      expect(movement.freeFlowSeconds).toBeCloseTo(movement.influenceZoneMeters / CRUISE, 6);
    }
  });
});
