import { describe, expect, it } from 'vitest';
import type { ArmConfig, ArmsConfig, IntersectionConfig, LaneConfig, TurnDirection } from '../config';
import { ARM_IDS, TURN_DIRECTIONS } from '../config';
import { createDefaultConfig } from '../config/defaults';
import { getPreset } from '../presets/presets';
import type { PresetId } from '../presets/presets';
import { ARM_LENGTH_METERS, STOP_LINE_SETBACK_METERS } from './constants';
import { sampleAtS } from './curve';
import type { PathSample } from './curve';
import { buildMovementPaths, exitLaneIndex, findMovement, movementId } from './paths';
import type { MovementGeometry } from './paths';

const LW = 3.5;

function armWithLanes(lanes: readonly LaneConfig[], cruiseSpeedMps = 13.9): ArmConfig {
  return {
    lanes,
    spawnRateVehPerHour: 300,
    turnMix: { left: 0.25, through: 0.5, right: 0.25 },
    cruiseSpeedMps,
  };
}

function configWithArms(arms: ArmsConfig): IntersectionConfig {
  return { ...createDefaultConfig(), arms };
}

function presetConfig(id: PresetId): IntersectionConfig {
  return structuredClone(getPreset(id).config);
}

const SHARED: LaneConfig = { designations: ['left', 'through', 'right'] };

// --- shared path validity checker (plain loops; single assertion) -----------

function pathIssues(movement: MovementGeometry): readonly string[] {
  const issues: string[] = [];
  const samples = movement.samples;
  if (!(movement.lengthMeters > 0)) issues.push('length not > 0');
  if (samples.length <= 10) issues.push(`only ${samples.length} samples`);
  if (samples[0]?.s !== 0) issues.push('first sample s != 0');
  const last = samples[samples.length - 1];
  if (!last || Math.abs(last.s - movement.lengthMeters) > 1e-9) issues.push('last sample s != length');
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    if (!Number.isFinite(s.s) || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.hx) || !Number.isFinite(s.hy)) {
      issues.push(`non-finite sample ${i}`);
      break;
    }
    const hLen = Math.sqrt(s.hx * s.hx + s.hy * s.hy);
    if (Math.abs(hLen - 1) > 1e-9) {
      issues.push(`sample ${i} heading |h| = ${hLen}`);
      break;
    }
    if (i > 0) {
      const p = samples[i - 1]!;
      if (!(s.s > p.s)) {
        issues.push(`s not strictly increasing at ${i}`);
        break;
      }
      // Tangent continuity: worst case is the tightest arc at 0.25 m steps (~0.05 rad).
      const dot = s.hx * p.hx + s.hy * p.hy;
      if (dot <= Math.cos(0.1)) {
        issues.push(`heading jump at ${i} (dot ${dot})`);
        break;
      }
    }
  }
  if (!(movement.stopLineS > 0) || !(movement.stopLineS < movement.lengthMeters)) issues.push('stopLineS out of range');
  if (movement.curveStartS !== movement.stopLineS) issues.push('curveStartS != stopLineS');
  if (!(movement.curveEndS >= movement.stopLineS)) issues.push('curveEndS < stopLineS');
  return issues;
}

function expectValidPath(movement: MovementGeometry): void {
  const issues = pathIssues(movement);
  if (issues.length > 0) throw new Error(`invalid path ${movement.id}: ${issues.join('; ')}`);
}

describe('paths: designation → path mapping (presets)', () => {
  for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
    it(`every (arm, lane, turn) designation of '${id}' maps to a valid path`, () => {
      const config = presetConfig(id);
      const movements = buildMovementPaths(config);
      for (const armId of ARM_IDS) {
        const lanes = config.arms[armId].lanes;
        for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
          for (const turn of lanes[laneIndex]!.designations) {
            const movement = findMovement(movements, armId, laneIndex, turn);
            expect(movement, `${armId}:${laneIndex}:${turn}`).toBeDefined();
            expectValidPath(movement!);
          }
        }
      }
    });
  }

  it('enumerates movements in canonical order with unique ids', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    expect(movements.map((m) => m.id).slice(0, 3)).toEqual(['north:0:left', 'north:1:through', 'north:1:right']);
    expect(new Set(movements.map((m) => m.id)).size).toBe(movements.length);
    expect(movements).toHaveLength(12);
  });

  it('starts at the approach outer end and ends on the exit arm outer end', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const through = findMovement(movements, 'north', 1, 'through')!;
    expect(through.entryPoint).toEqual({ x: -1.5 * LW, y: -ARM_LENGTH_METERS });
    expect(through.exitPoint).toEqual({ x: -1.5 * LW, y: ARM_LENGTH_METERS });
    expect(through.exitArm).toBe('south');

    const left = findMovement(movements, 'north', 0, 'left')!;
    expect(left.exitArm).toBe('east');
    expect(left.exitPoint).toEqual({ x: ARM_LENGTH_METERS, y: LW / 2 });

    const right = findMovement(movements, 'north', 1, 'right')!;
    expect(right.exitArm).toBe('west');
    expect(right.exitPoint).toEqual({ x: -ARM_LENGTH_METERS, y: -1.5 * LW });
  });
});

describe('paths: exit-lane mapping', () => {
  it('through/left clamp to the receiving count; right mirrors from the right', () => {
    expect(exitLaneIndex('through', 0, 3, 3)).toBe(0);
    expect(exitLaneIndex('through', 2, 3, 1)).toBe(0); // 3-lane arm into 1-lane exit merges
    expect(exitLaneIndex('left', 2, 3, 2)).toBe(1);
    expect(exitLaneIndex('right', 2, 3, 3)).toBe(2); // rightmost → rightmost
    expect(exitLaneIndex('right', 0, 3, 3)).toBe(0); // leftmost right-feeder → innermost
    expect(exitLaneIndex('right', 0, 2, 1)).toBe(0);
  });

  it('lands jogged through paths exactly on the merged exit lane center', () => {
    const config = {
      ...presetConfig('light'),
      arms: {
        ...presetConfig('light').arms,
        north: armWithLanes([
          { designations: ['through'] },
          { designations: ['through'] },
          { designations: ['through', 'right'] },
        ]),
      },
    };
    const movements = buildMovementPaths(config);
    for (const laneIndex of [0, 1, 2]) {
      const movement = findMovement(movements, 'north', laneIndex, 'through')!;
      expect(movement.exitLaneIndex).toBe(0); // south arm has a single lane
      expect(movement.exitPoint).toEqual({ x: -LW / 2, y: ARM_LENGTH_METERS });
      expectValidPath(movement);
    }
    // Lateral jogs are gentle enough to keep v_t at cruise (see freeflow tests)
    // and complete well inside the exit arm.
    const lane2 = findMovement(movements, 'north', 2, 'through')!;
    expect(lane2.turnRadiusMeters).not.toBeNull();
    expect(lane2.turnRadiusMeters!).toBeGreaterThan((13.9 * 13.9) / 1.7);
  });
});

describe('paths: turn geometry', () => {
  it('derives quarter-arc radii from the lane geometry (R1 §6.1 inputs)', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    // R_left = by + setback + exit-lane offset = 7 + 6 + 1.75.
    expect(findMovement(movements, 'north', 0, 'left')!.turnRadiusMeters).toBeCloseTo(14.75, 9);
    // R_right = by + setback − offset = 7 + 6 − 5.25 (rightmost lane ↔ rightmost exit).
    expect(findMovement(movements, 'north', 1, 'right')!.turnRadiusMeters).toBeCloseTo(7.75, 9);
    // Through on aligned lanes is straight: R = null.
    expect(findMovement(movements, 'north', 1, 'through')!.turnRadiusMeters).toBeNull();
  });

  it('keeps arcs on the road: samples stay within the plus-shape (corner tolerance 1 m)', () => {
    const config = presetConfig('balanced');
    const movements = buildMovementPaths(config);
    const by = 7;
    const bx = 7;
    const TOLERANCE = 1; // CORNER_CLIP_TOLERANCE_METERS
    for (const movement of movements) {
      for (const sample of movement.samples) {
        const inVerticalRoad = Math.abs(sample.x) <= bx + TOLERANCE;
        const inHorizontalRoad = Math.abs(sample.y) <= by + TOLERANCE;
        expect(inVerticalRoad || inHorizontalRoad, `${movement.id} at (${sample.x}, ${sample.y})`).toBe(true);
      }
    }
  });

  it('aligns through paths with matched lane counts exactly on the lane centerline', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const through = findMovement(movements, 'north', 1, 'through')!;
    for (const sample of through.samples) {
      expect(Math.abs(sample.x - -1.5 * LW)).toBeLessThan(1e-9);
    }
  });

  it('arc samples lie on the analytic circle (radius constant along the arc)', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const left = findMovement(movements, 'north', 0, 'left')!;
    const R = left.turnRadiusMeters!;
    // Arc center = stop point + R · (left of inbound) = (−1.75 + R, −13).
    const cx = -1.75 + R;
    const cy = -13;
    for (const sample of left.samples) {
      if (sample.s > left.stopLineS && sample.s < left.curveEndS) {
        const d = Math.hypot(sample.x - cx, sample.y - cy);
        expect(d).toBeCloseTo(R, 6);
      }
    }
  });
});

describe('paths: exhaustive designation combos at 1/2/3 lanes', () => {
  const COMBOS: readonly (readonly TurnDirection[])[] = [
    ['left'],
    ['through'],
    ['right'],
    ['left', 'through'],
    ['left', 'right'],
    ['through', 'right'],
    ['left', 'through', 'right'],
  ];

  function buildWithNorthLanes(lanes: readonly LaneConfig[]): readonly MovementGeometry[] {
    return buildMovementPaths(
      configWithArms({ north: armWithLanes(lanes), east: armWithLanes([SHARED]), south: armWithLanes([SHARED]), west: armWithLanes([SHARED]) }),
    );
  }

  it('1-lane: all 7 designation combos map every designation to a valid path', () => {
    for (const combo of COMBOS) {
      const lanes: LaneConfig[] = [{ designations: combo }];
      const movements = buildWithNorthLanes(lanes);
      const expected = combo.length + 3 * 3; // + three shared lanes on each other arm
      expect(movements).toHaveLength(expected);
      for (const turn of combo) {
        const movement = findMovement(movements, 'north', 0, turn);
        expect(movement, `north:0:${turn} for [${combo.join(',')}]`).toBeDefined();
        expectValidPath(movement!);
      }
    }
  });

  it('2-lane: all 49 combos map every designation to a valid path', () => {
    for (const comboA of COMBOS) {
      for (const comboB of COMBOS) {
        const lanes: LaneConfig[] = [{ designations: comboA }, { designations: comboB }];
        const movements = buildWithNorthLanes(lanes);
        expect(movements).toHaveLength(comboA.length + comboB.length + 9);
        for (const [laneIndex, combo] of [comboA, comboB].entries()) {
          for (const turn of combo) {
            const movement = findMovement(movements, 'north', laneIndex, turn);
            expect(movement, `north:${laneIndex}:${turn} for [${comboA}]/[${comboB}]`).toBeDefined();
            expectValidPath(movement!);
          }
        }
      }
    }
  });

  it('3-lane: all 343 combos map every designation to a valid path (max 9 movements/arm)', () => {
    let checked = 0;
    for (const c0 of COMBOS) {
      for (const c1 of COMBOS) {
        for (const c2 of COMBOS) {
          const lanes: LaneConfig[] = [{ designations: c0 }, { designations: c1 }, { designations: c2 }];
          const movements = buildWithNorthLanes(lanes);
          expect(movements).toHaveLength(c0.length + c1.length + c2.length + 9);
          for (const [laneIndex, combo] of [c0, c1, c2].entries()) {
            for (const turn of combo) {
              const movement = findMovement(movements, 'north', laneIndex, turn);
              if (movement === undefined) throw new Error(`missing north:${laneIndex}:${turn} for ${c0}/${c1}/${c2}`);
              expectValidPath(movement);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1700);
  });

  it('ids are stable strings regardless of designation list order within a lane', () => {
    const a = buildMovementPaths(
      configWithArms({ north: armWithLanes([{ designations: ['through', 'left'] }]), east: armWithLanes([SHARED]), south: armWithLanes([SHARED]), west: armWithLanes([SHARED]) }),
    );
    const b = buildMovementPaths(
      configWithArms({ north: armWithLanes([{ designations: ['left', 'through'] }]), east: armWithLanes([SHARED]), south: armWithLanes([SHARED]), west: armWithLanes([SHARED]) }),
    );
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    expect(a.map((m) => m.id)).toContain(movementId('north', 0, 'left'));
    expect(a.map((m) => m.id)).toContain(movementId('north', 0, 'through'));
  });
});

describe('paths: stepping support', () => {
  it('sampleAtS interpolates monotonically along arc length and clamps at the ends', () => {
    const movements = buildMovementPaths(presetConfig('balanced'));
    const left = findMovement(movements, 'north', 0, 'left')!;
    const first = sampleAtS(left.samples, -5);
    expect(first.s).toBe(0);
    const last = sampleAtS(left.samples, left.lengthMeters + 5);
    expect(last.s).toBeCloseTo(left.lengthMeters, 9);
    let prevS = -1;
    for (let s = 0; s <= left.lengthMeters; s += 3.7) {
      const sample: PathSample = sampleAtS(left.samples, s);
      expect(sample.s).toBe(s);
      expect(sample.s).toBeGreaterThan(prevS);
      prevS = sample.s;
      // Positions move smoothly: consecutive probes stay close.
      const d = Math.hypot(sample.x - sampleAtS(left.samples, Math.max(0, s - 3.7)).x, sample.y - sampleAtS(left.samples, Math.max(0, s - 3.7)).y);
      expect(d).toBeLessThanOrEqual(3.7 + 1e-6);
    }
    // The stop-line probe sits on the stop-line point.
    const atStop = sampleAtS(left.samples, left.stopLineS);
    expect(Math.hypot(atStop.x - left.stopLinePoint.x, atStop.y - left.stopLinePoint.y)).toBeLessThan(0.5);
  });

  it('every turn designation of every arm maps to a path (turn × arm totality)', () => {
    const config = presetConfig('gridlock-risk');
    const movements = buildMovementPaths(config);
    for (const armId of ARM_IDS) {
      for (const turn of TURN_DIRECTIONS) {
        const movement = findMovement(movements, armId, turn === 'left' ? 0 : 1, turn);
        expect(movement, `${armId} ${turn}`).toBeDefined();
        expect(movement!.stopLineS).toBeCloseTo(ARM_LENGTH_METERS - (2 * LW + STOP_LINE_SETBACK_METERS), 6);
      }
    }
  });
});
