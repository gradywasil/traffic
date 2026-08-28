/**
 * Road surface + lane-marking geometry (task U1), in world meters.
 *
 * Pure functions of the F3 layout: the asphalt silhouette (one rectangle
 * per arm plus the box), edge lines, the double center line separating
 * opposing directions, dashed lane dividers (expanded into explicit dash
 * segments so the draw list stays declarative — no painter-side dash
 * state), and the per-lane stop bars.
 *
 * Arm-local frame (matches layout.ts): a point at longitudinal distance t
 * from the intersection center and lateral offset l from the arm's
 * centerline is `p = (−u)·t + r·l` with u = inbound heading, r = right of
 * inbound. Markings stop at the box boundary (`boundaryDistance`) — inside
 * the box the surface stays unmarked asphalt.
 */
import { ARM_IDS } from '../config';
import type { IntersectionGeometry } from '../geom';
import { ARM_LENGTH_METERS } from '../geom';
import type { IntersectionLayout } from '../geom/layout';
import type { Vec2 } from '../geom';
import { vadd, vscale } from '../geom';

/** Edge-line inset from the outer road boundary (m). */
export const EDGE_LINE_INSET_METERS = 0.25;
/** Lateral offsets of the double center line's two lines (m). */
export const CENTER_LINE_OFFSET_METERS = 0.18;
/** Dash pattern for lane dividers: 3 m painted, 6 m gap (m). */
export const LANE_DASH_METERS = 3;
export const LANE_DASH_GAP_METERS = 6;
/** Stop-bar thickness (m). */
export const STOP_BAR_THICKNESS_METERS = 0.5;

export interface MarkingGeometry {
  /** Asphalt fills: one rectangle per arm + the intersection box. */
  readonly roadPolygons: readonly (readonly Vec2[])[];
  /** Solid edge lines (2 per arm). */
  readonly edgeLines: readonly (readonly Vec2[])[];
  /** Double-yellow center line segments (2 per arm). */
  readonly centerLines: readonly (readonly Vec2[])[];
  /** Dashed lane-divider dash segments (explicit; painter strokes plainly). */
  readonly laneDividers: readonly (readonly Vec2[])[];
  /** Stop bars: thick short strokes, one per approach lane. */
  readonly stopBars: readonly (readonly Vec2[])[];
}

/** Point on `arm` at longitudinal `t` (from center) and lateral `l`. */
function armPoint(layout: IntersectionLayout, armId: (typeof ARM_IDS)[number], t: number, l: number): Vec2 {
  const arm = layout.arms[armId];
  const outbound = vscale(arm.inboundHeading, -1);
  return vadd(vscale(outbound, t), vscale(arm.rightOfInbound, l));
}

/** Full-arm asphalt rectangle: axis strip of width 2·n·lw from the center out. */
function armRoadPolygon(layout: IntersectionLayout, armId: (typeof ARM_IDS)[number]): Vec2[] {
  const arm = layout.arms[armId];
  const half = arm.laneCount * layout.laneWidthMeters;
  return [
    armPoint(layout, armId, 0, -half),
    armPoint(layout, armId, 0, half),
    armPoint(layout, armId, ARM_LENGTH_METERS, half),
    armPoint(layout, armId, ARM_LENGTH_METERS, -half),
  ];
}

/**
 * Expand [t0, t1] into dash segments [s, s + LANE_DASH] spaced
 * LANE_DASH_GAP apart, phase-aligned at t0. Deterministic.
 */
export function expandDashes(t0: number, t1: number): readonly number[] {
  const starts: number[] = [];
  const period = LANE_DASH_METERS + LANE_DASH_GAP_METERS;
  for (let s = t0; s + LANE_DASH_METERS <= t1; s += period) starts.push(s);
  return starts;
}

/** Build all static road/markings geometry from the F3 output. */
export function buildMarkings(geometry: IntersectionGeometry): MarkingGeometry {
  const layout = geometry.layout;
  const roadPolygons: Vec2[][] = [layout.boxPolygon.map((p) => ({ ...p }))];
  const edgeLines: Vec2[][] = [];
  const centerLines: Vec2[][] = [];
  const laneDividers: Vec2[][] = [];
  const stopBars: Vec2[][] = [];

  for (const armId of ARM_IDS) {
    const arm = layout.arms[armId];
    roadPolygons.push(armRoadPolygon(layout, armId));

    const edgeLateral = arm.laneCount * layout.laneWidthMeters - EDGE_LINE_INSET_METERS;
    for (const sign of [-1, 1]) {
      edgeLines.push([
        armPoint(layout, armId, arm.boundaryDistance, sign * edgeLateral),
        armPoint(layout, armId, ARM_LENGTH_METERS, sign * edgeLateral),
      ]);
    }

    for (const sign of [-1, 1]) {
      centerLines.push([
        armPoint(layout, armId, arm.boundaryDistance, sign * CENTER_LINE_OFFSET_METERS),
        armPoint(layout, armId, ARM_LENGTH_METERS, sign * CENTER_LINE_OFFSET_METERS),
      ]);
    }

    // Dashed dividers between adjacent lanes, both sides of the centerline.
    // Approach side (lateral +): stop line → arm end. Exit side (lateral −):
    // box boundary → arm end.
    for (let k = 1; k < arm.laneCount; k += 1) {
      const lateral = k * layout.laneWidthMeters;
      for (const s of expandDashes(arm.stopLineDistance, ARM_LENGTH_METERS)) {
        laneDividers.push([
          armPoint(layout, armId, s, lateral),
          armPoint(layout, armId, s + LANE_DASH_METERS, lateral),
        ]);
      }
      for (const s of expandDashes(arm.boundaryDistance, ARM_LENGTH_METERS)) {
        laneDividers.push([
          armPoint(layout, armId, s, -lateral),
          armPoint(layout, armId, s + LANE_DASH_METERS, -lateral),
        ]);
      }
    }
  }

  for (const lane of geometry.lanePolygons) {
    if (lane.side === 'approach' && lane.stopLineSegment !== undefined) {
      stopBars.push(lane.stopLineSegment.map((p) => ({ ...p })));
    }
  }

  return { roadPolygons, edgeLines, centerLines, laneDividers, stopBars };
}
