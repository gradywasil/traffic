import { describe, expect, it } from 'vitest';
import type { ArmConfig, ArmsConfig, IntersectionConfig, LaneConfig } from '../config';
import { ARM_IDS } from '../config';
import { createDefaultConfig } from '../config/defaults';
import { getPreset } from '../presets/presets';
import type { PresetId } from '../presets/presets';
import { ARM_LENGTH_METERS, MIN_QUEUE_STORAGE_METERS, STOP_LINE_SETBACK_METERS } from './constants';
import { entryZoneMeters } from './freeflow';
import { buildLayout, buildLanePolygons } from './layout';

const LW = 3.5;

function armWithLanes(lanes: readonly LaneConfig[]): ArmConfig {
  return {
    lanes,
    spawnRateVehPerHour: 300,
    turnMix: { left: 0.25, through: 0.5, right: 0.25 },
    cruiseSpeedMps: 13.9,
  };
}

function configWithArms(arms: ArmsConfig): IntersectionConfig {
  return { ...createDefaultConfig(), arms };
}

function presetConfig(id: PresetId): IntersectionConfig {
  return structuredClone(getPreset(id).config);
}

const TWO_LANE: LaneConfig[] = [{ designations: ['left'] }, { designations: ['through', 'right'] }];
const THREE_LANE: LaneConfig[] = [{ designations: ['left'] }, { designations: ['through'] }, { designations: ['through', 'right'] }];

function symmetric(lanes: readonly LaneConfig[]): ArmsConfig {
  const arm = armWithLanes(lanes);
  return { north: arm, east: arm, south: arm, west: arm };
}

describe('layout: box and lane placement', () => {
  it('sizes the box from the widest arm on each axis (asymmetric lane counts)', () => {
    const layout = buildLayout(
      configWithArms({
        north: armWithLanes(THREE_LANE),
        south: armWithLanes([{ designations: ['left', 'through', 'right'] }]),
        east: armWithLanes(TWO_LANE),
        west: armWithLanes([{ designations: ['left', 'through', 'right'] }]),
      }),
    );
    expect(layout.boxHalfWidthX).toBeCloseTo(3 * LW, 10); // vertical road = max(N, S)
    expect(layout.boxHalfWidthY).toBeCloseTo(2 * LW, 10); // horizontal road = max(E, W)
    // Boundaries: N/S arms cross at the horizontal half-width, E/W at the vertical.
    expect(layout.arms.north.boundaryDistance).toBeCloseTo(layout.boxHalfWidthY, 10);
    expect(layout.arms.east.boundaryDistance).toBeCloseTo(layout.boxHalfWidthX, 10);
  });

  it('orders lanes leftmost-first: lane 0 hugs the centerline on the driver side (right-hand traffic)', () => {
    const layout = buildLayout(configWithArms(symmetric(TWO_LANE)));
    const north = layout.arms.north;
    // North approach is southbound (heading +y): its lanes sit west of the
    // centerline; lane 0 (leftmost) is nearest it.
    expect(north.approachLaneCentersAtStopLine[0]).toEqual({ x: -LW / 2, y: -13 });
    expect(north.approachLaneCentersAtStopLine[1]).toEqual({ x: -1.5 * LW, y: -13 });
    // North arm exits are northbound: east of the centerline, lane 0 nearest.
    expect(north.exitLaneCentersAtBoundary[0]).toEqual({ x: LW / 2, y: -7 });
    expect(north.exitLaneCentersAtBoundary[1]).toEqual({ x: 1.5 * LW, y: -7 });
    // East approach is westbound: lanes on the north half, lane 0 nearest.
    const east = layout.arms.east;
    expect(east.approachLaneCentersAtStopLine[0]).toEqual({ x: 13, y: -LW / 2 });
    expect(east.exitLaneCentersAtBoundary[0]).toEqual({ x: 7, y: LW / 2 });
  });

  it('places stop lines one setback behind the box edge and arms run 120 m from center', () => {
    const layout = buildLayout(configWithArms(symmetric(TWO_LANE)));
    for (const armId of ARM_IDS) {
      const arm = layout.arms[armId];
      expect(arm.stopLineDistance).toBeCloseTo(arm.boundaryDistance + STOP_LINE_SETBACK_METERS, 10);
      expect(arm.approachLengthMeters).toBeCloseTo(ARM_LENGTH_METERS - arm.stopLineDistance, 10);
      expect(arm.exitLengthMeters).toBeCloseTo(ARM_LENGTH_METERS - arm.boundaryDistance, 10);
      // Outer waypoints sit exactly at the arm end.
      const entry = arm.approachLaneEntryPoints[0]!;
      const exit = arm.exitLaneExitPoints[0]!;
      expect(Math.max(Math.abs(entry.x), Math.abs(entry.y))).toBeCloseTo(ARM_LENGTH_METERS, 6);
      expect(Math.max(Math.abs(exit.x), Math.abs(exit.y))).toBeCloseTo(ARM_LENGTH_METERS, 6);
    }
  });

  it('satisfies the research constraint: approach ≥ U + 50 m queue storage for every preset arm (R1 §6.1)', () => {
    for (const id of ['light', 'balanced', 'gridlock-risk'] as const) {
      const config = presetConfig(id);
      const layout = buildLayout(config);
      for (const armId of ARM_IDS) {
        const arm = layout.arms[armId];
        const U = entryZoneMeters(
          config.arms[armId].cruiseSpeedMps,
          config.dt,
          config.modelParams.comfortableDecelMps2,
        );
        expect(arm.approachLengthMeters).toBeGreaterThanOrEqual(U + MIN_QUEUE_STORAGE_METERS);
      }
    }
  });

  it('builds lane polygons as lw-wide rectangles, approach lanes with stop-line segments', () => {
    const layout = buildLayout(configWithArms(symmetric(TWO_LANE)));
    const polygons = buildLanePolygons(layout);
    expect(polygons).toHaveLength(16); // 4 arms × (2 approach + 2 exit)
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y);
    for (const lane of polygons) {
      expect(lane.polygon).toHaveLength(4);
      const [a, b, c, d] = lane.polygon;
      if (!a || !b || !c || !d) throw new Error('polygon corner missing');
      expect(dist(a, b)).toBeCloseTo(LW, 6);
      expect(dist(c, d)).toBeCloseTo(LW, 6);
      expect(dist(b, c)).toBeGreaterThan(90); // ~107 approach / ~113 exit
      if (lane.side === 'approach') {
        expect(lane.stopLineSegment).toBeDefined();
        expect(lane.stopLineSegment).toHaveLength(2);
      } else {
        expect(lane.stopLineSegment).toBeUndefined();
      }
    }
  });
});
