/**
 * Road layout from an IntersectionConfig (task F3).
 *
 * The intersection is a plus-shaped road: four two-way arms meeting at a
 * centered box. Each arm carries its own lane count in each direction; the
 * box spans the widest road on each axis:
 *   box = [−bx, bx] × [−by, by], bx = max(north, south lanes)·laneWidth,
 *   by = max(east, west lanes)·laneWidth.
 * Arms extend ARM_LENGTH_METERS from the center; approach stop lines sit
 * STOP_LINE_SETBACK_METERS before the box edge.
 *
 * Lane order follows the config contract: `lanes[i]`, index 0, is the
 * leftmost lane from the approaching driver's perspective — nearest the
 * road centerline in right-hand traffic.
 */
import { ARM_LENGTH_METERS, STOP_LINE_SETBACK_METERS } from './constants';
import { rightOf, vadd, vneg, vscale, itemAt } from './vec';
import type { Vec2 } from './vec';
import { ARM_IDS } from '../config';
import type { ArmConfig, ArmId, ArmsConfig, IntersectionConfig } from '../config';

/** Inbound (toward the box) unit heading of each arm's approach. */
export const INBOUND_HEADING: Readonly<Record<ArmId, Vec2>> = {
  north: { x: 0, y: 1 }, // southbound down the screen
  east: { x: -1, y: 0 }, // westbound
  south: { x: 0, y: -1 }, // northbound
  west: { x: 1, y: 0 }, // eastbound
};

export interface ArmLayout {
  readonly armId: ArmId;
  readonly laneCount: number;
  /** Unit heading toward the box (approach direction). */
  readonly inboundHeading: Vec2;
  /** Unit heading away from the box (this arm's exit direction). */
  readonly outboundHeading: Vec2;
  /** Lateral unit vector toward the approaching driver's right. */
  readonly rightOfInbound: Vec2;
  /** Lateral unit vector toward the exiting driver's right. */
  readonly rightOfOutbound: Vec2;
  /** Distance from center to the box edge along the arm axis (cross road half-width). */
  readonly boundaryDistance: number;
  /** Distance from center to the approach stop line (= boundary + setback). */
  readonly stopLineDistance: number;
  /** Usable approach length: stop line → arm end. */
  readonly approachLengthMeters: number;
  /** Usable exit length: box edge → arm end. */
  readonly exitLengthMeters: number;
  /** Centerline point at the approach stop line. */
  readonly stopLineCenter: Vec2;
  /** Centerline point where this arm's outbound traffic leaves the box. */
  readonly exitBoundaryCenter: Vec2;
  /** Approach lane centers where they cross the stop line (index 0 leftmost). */
  readonly approachLaneCentersAtStopLine: readonly Vec2[];
  /** Approach lane centers at the arm's outer end (spawn waypoints). */
  readonly approachLaneEntryPoints: readonly Vec2[];
  /** Exit lane centers where they cross the box boundary (index 0 leftmost). */
  readonly exitLaneCentersAtBoundary: readonly Vec2[];
  /** Exit lane centers at the arm's outer end (despawn waypoints). */
  readonly exitLaneExitPoints: readonly Vec2[];
}

export interface IntersectionLayout {
  readonly laneWidthMeters: number;
  /** Half-width of the vertical road at the box (max of N/S lane counts × lw). */
  readonly boxHalfWidthX: number;
  /** Half-width of the horizontal road at the box (max of E/W lane counts × lw). */
  readonly boxHalfWidthY: number;
  readonly boxPolygon: readonly Vec2[];
  readonly arms: Readonly<Record<ArmId, ArmLayout>>;
}

function lanesOf(arms: ArmsConfig, armId: ArmId): ArmConfig['lanes'] {
  const lanes = arms[armId]?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new Error(`arm '${armId}' has no usable lane list (validate the config first, task F2)`);
  }
  return lanes;
}

export function buildLayout(config: IntersectionConfig): IntersectionLayout {
  const lw = config.geometry.laneWidthMeters;
  const laneCounts = { north: 0, east: 0, south: 0, west: 0 } as Record<ArmId, number>;
  for (const armId of ARM_IDS) laneCounts[armId] = lanesOf(config.arms, armId).length;

  const boxHalfWidthX = Math.max(laneCounts.north, laneCounts.south) * lw;
  const boxHalfWidthY = Math.max(laneCounts.east, laneCounts.west) * lw;

  const arms = {} as Record<ArmId, ArmLayout>;
  for (const armId of ARM_IDS) {
    const n = laneCounts[armId];
    // This arm's traffic crosses the box edge at the CROSS road's half-width.
    const boundary = armId === 'north' || armId === 'south' ? boxHalfWidthY : boxHalfWidthX;
    const stopDistance = boundary + STOP_LINE_SETBACK_METERS;
    const u = INBOUND_HEADING[armId];
    const outbound = vneg(u);
    const rightIn = rightOf(u);
    const rightOut = rightOf(outbound);
    const stopLineCenter = vscale(u, -stopDistance);
    const exitBoundaryCenter = vscale(u, -boundary);

    const approachLaneCentersAtStopLine: Vec2[] = [];
    const approachLaneEntryPoints: Vec2[] = [];
    const exitLaneCentersAtBoundary: Vec2[] = [];
    const exitLaneExitPoints: Vec2[] = [];
    for (let i = 0; i < n; i += 1) {
      const lateral = vscale(rightIn, (i + 0.5) * lw);
      approachLaneCentersAtStopLine.push(vadd(stopLineCenter, lateral));
      approachLaneEntryPoints.push(vadd(vadd(stopLineCenter, lateral), vscale(u, -(ARM_LENGTH_METERS - stopDistance))));
    }
    for (let j = 0; j < n; j += 1) {
      const lateral = vscale(rightOut, (j + 0.5) * lw);
      exitLaneCentersAtBoundary.push(vadd(exitBoundaryCenter, lateral));
      exitLaneExitPoints.push(vadd(vadd(exitBoundaryCenter, lateral), vscale(outbound, ARM_LENGTH_METERS - boundary)));
    }

    arms[armId] = {
      armId,
      laneCount: n,
      inboundHeading: u,
      outboundHeading: outbound,
      rightOfInbound: rightIn,
      rightOfOutbound: rightOut,
      boundaryDistance: boundary,
      stopLineDistance: stopDistance,
      approachLengthMeters: ARM_LENGTH_METERS - stopDistance,
      exitLengthMeters: ARM_LENGTH_METERS - boundary,
      stopLineCenter,
      exitBoundaryCenter,
      approachLaneCentersAtStopLine,
      approachLaneEntryPoints,
      exitLaneCentersAtBoundary,
      exitLaneExitPoints,
    };
  }

  return {
    laneWidthMeters: lw,
    boxHalfWidthX,
    boxHalfWidthY,
    boxPolygon: [
      { x: -boxHalfWidthX, y: -boxHalfWidthY },
      { x: boxHalfWidthX, y: -boxHalfWidthY },
      { x: boxHalfWidthX, y: boxHalfWidthY },
      { x: -boxHalfWidthX, y: boxHalfWidthY },
    ],
    arms,
  };
}

/** A lane rectangle for rendering: 4 corners in deterministic order. */
export interface LanePolygon {
  readonly arm: ArmId;
  readonly side: 'approach' | 'exit';
  readonly laneIndex: number;
  readonly polygon: readonly Vec2[];
  /** Two points spanning the lane at the stop line (approach lanes only). */
  readonly stopLineSegment?: readonly Vec2[];
}

/** Lane polygons for every arm: approach lanes and exit lanes. */
export function buildLanePolygons(layout: IntersectionLayout): readonly LanePolygon[] {
  const lw = layout.laneWidthMeters;
  const polygons: LanePolygon[] = [];
  for (const armId of ARM_IDS) {
    const arm = layout.arms[armId];
    const half = lw / 2;
    for (let i = 0; i < arm.laneCount; i += 1) {
      const entry = itemAt(arm.approachLaneEntryPoints, i);
      const stop = itemAt(arm.approachLaneCentersAtStopLine, i);
      const right = arm.rightOfInbound;
      polygons.push({
        arm: armId,
        side: 'approach',
        laneIndex: i,
        polygon: [
          vadd(entry, vscale(right, -half)),
          vadd(entry, vscale(right, half)),
          vadd(stop, vscale(right, half)),
          vadd(stop, vscale(right, -half)),
        ],
        stopLineSegment: [vadd(stop, vscale(right, -half)), vadd(stop, vscale(right, half))],
      });
      const boundary = itemAt(arm.exitLaneCentersAtBoundary, i);
      const exit = itemAt(arm.exitLaneExitPoints, i);
      const rightE = arm.rightOfOutbound;
      polygons.push({
        arm: armId,
        side: 'exit',
        laneIndex: i,
        polygon: [
          vadd(boundary, vscale(rightE, -half)),
          vadd(boundary, vscale(rightE, half)),
          vadd(exit, vscale(rightE, half)),
          vadd(exit, vscale(rightE, -half)),
        ],
      });
    }
  }
  return polygons;
}
