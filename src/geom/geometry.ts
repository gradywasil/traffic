/**
 * Intersection geometry facade (task F3): the single entry point that turns
 * an `IntersectionConfig` into everything the renderer (U1), car-following
 * (F4), claim arbitration (F5) and metrics (F7) consume:
 *
 * - lane polygons, box polygon, stop-line positions (layout);
 * - one arc-length-parametrized path per (arm, lane, turn) movement, with
 *   turn radius R_p, turn speed v_t, entry/exit influence gates and the
 *   closed-form free-flow time FF(p) (research R1 §6.1);
 * - footprint-padded conflict zones per movement pair (research R1 §4.1);
 * - canvas mapping + bounds so the 1280×720 fit acceptance is checkable.
 *
 * Pure and deterministic: same config ⇒ identical output (verified by
 * stable serialization). Warnings — never throws — flag configs whose
 * geometry violates a research constraint (approach too short for the entry
 * gate + queue storage, exit gate past despawn, corner clipping).
 */
import {
  CANVAS_CENTER_PX,
  CANVAS_LOGICAL_HEIGHT_PX,
  CANVAS_LOGICAL_WIDTH_PX,
  CORNER_CLIP_TOLERANCE_METERS,
  MIN_QUEUE_STORAGE_METERS,
  PX_PER_METER,
} from './constants';
import type { ArmId, IntersectionConfig, TurnDirection } from '../config';
import { ARM_IDS } from '../config';
import { computeConflictZones } from './conflicts';
import type { ConflictZone } from './conflicts';
import { entryZoneMeters } from './freeflow';
import { buildLanePolygons, buildLayout, INBOUND_HEADING } from './layout';
import type { IntersectionLayout, LanePolygon } from './layout';
import { buildMovementPathsFromLayout, findMovement } from './paths';
import type { MovementGeometry } from './paths';
import { leftOf, rightOf, vadd, vlen, vscale, vsub } from './vec';
import type { Vec2 } from './vec';

export interface GeometryWarning {
  readonly kind: 'approach-storage' | 'corner-clip' | 'exit-gate';
  readonly subject: string;
  readonly message: string;
}

export interface IntersectionGeometry {
  readonly layout: IntersectionLayout;
  /** All movements in canonical order (arm N,E,S,W → lane → left,through,right). */
  readonly movements: readonly MovementGeometry[];
  readonly lanePolygons: readonly LanePolygon[];
  readonly conflictZones: readonly ConflictZone[];
  readonly warnings: readonly GeometryWarning[];
}

export function buildIntersectionGeometry(config: IntersectionConfig): IntersectionGeometry {
  const layout = buildLayout(config);
  const rawMovements = buildMovementPathsFromLayout(config, layout);
  const { zones, perMovement } = computeConflictZones(rawMovements, config.modelParams.carLengthMeters);
  const movements = rawMovements.map((movement) => ({
    ...movement,
    conflictZones: perMovement.get(movement.id) ?? [],
  }));
  return {
    layout,
    movements,
    lanePolygons: buildLanePolygons(layout),
    conflictZones: zones,
    warnings: collectWarnings(config, layout, movements),
  };
}

/** Movement lookup by designation; undefined when the lane does not serve the turn. */
export function getMovement(
  geometry: IntersectionGeometry,
  arm: ArmId,
  laneIndex: number,
  turn: TurnDirection,
): MovementGeometry | undefined {
  return findMovement(geometry.movements, arm, laneIndex, turn);
}

function collectWarnings(
  config: IntersectionConfig,
  layout: IntersectionLayout,
  movements: readonly MovementGeometry[],
): GeometryWarning[] {
  const warnings: GeometryWarning[] = [];

  // R1 §6.1: approach arm ≥ U + queue storage.
  for (const armId of ARM_IDS) {
    const arm = layout.arms[armId];
    const cruise = config.arms[armId].cruiseSpeedMps;
    const U = entryZoneMeters(cruise, config.dt, config.modelParams.comfortableDecelMps2);
    if (arm.approachLengthMeters < U + MIN_QUEUE_STORAGE_METERS) {
      warnings.push({
        kind: 'approach-storage',
        subject: `arms.${armId}`,
        message: `approach length ${arm.approachLengthMeters.toFixed(1)} m < entry gate U ${U.toFixed(1)} m + ${MIN_QUEUE_STORAGE_METERS} m queue storage (R1 §6.1); raise arm length or lower cruise speed`,
      });
    }
  }

  for (const movement of movements) {
    // Exit gate must sit on the path (R1 §6.1 exit arm ≥ D).
    if (movement.exitGateS > movement.lengthMeters - 0.5) {
      warnings.push({
        kind: 'exit-gate',
        subject: movement.id,
        message: `exit gate s=${movement.exitGateS.toFixed(1)} m reaches the path end ${movement.lengthMeters.toFixed(1)} m; exit arm too short for re-acceleration distance D`,
      });
    }
    // Turn arcs clipping the square road corner beyond tolerance.
    const clip = cornerClipMeters(layout, movement);
    if (clip !== null && clip > CORNER_CLIP_TOLERANCE_METERS) {
      warnings.push({
        kind: 'corner-clip',
        subject: movement.id,
        message: `turn arc clips the road corner by ${clip.toFixed(2)} m (tolerance ${CORNER_CLIP_TOLERANCE_METERS} m); cosmetic — round drawn curbs or widen the setback`,
      });
    }
  }

  return warnings;
}

/** Corner overhang of a turn arc in meters (null for straight paths). */
export function cornerClipMeters(layout: IntersectionLayout, movement: MovementGeometry): number | null {
  if (movement.turn === 'through' || movement.turnRadiusMeters === null) return null;
  const arm = layout.arms[movement.arm];
  const u = INBOUND_HEADING[movement.arm];
  const v = movement.turn === 'left' ? leftOf(u) : rightOf(u);
  const center = vadd(movement.stopLinePoint, vscale(v, movement.turnRadiusMeters));
  const lateralHalfWidth = v.x !== 0 ? layout.boxHalfWidthX : layout.boxHalfWidthY;
  const corner = vadd(vscale(u, -arm.boundaryDistance), vscale(v, lateralHalfWidth));
  const clearance = vlen(vsub(corner, center)) - movement.turnRadiusMeters;
  return clearance > 0 ? clearance : 0;
}

// --- canvas mapping ----------------------------------------------------------

/** World meters → logical canvas pixels (1280×720 frame, center at 640,360). */
export function worldToCanvas(point: Vec2): Vec2 {
  return {
    x: CANVAS_CENTER_PX.x + point.x * PX_PER_METER,
    y: CANVAS_CENTER_PX.y + point.y * PX_PER_METER,
  };
}

export interface CanvasBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Axis-aligned bounds of all geometry in logical canvas pixels. */
export function geometryCanvasBounds(geometry: IntersectionGeometry): CanvasBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec2): void => {
    const p = worldToCanvas(point);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const corner of geometry.layout.boxPolygon) include(corner);
  for (const lane of geometry.lanePolygons) for (const corner of lane.polygon) include(corner);
  for (const movement of geometry.movements) {
    include(movement.entryPoint);
    include(movement.exitPoint);
    for (const sample of movement.samples) include({ x: sample.x, y: sample.y });
  }
  for (const zone of geometry.conflictZones) for (const corner of zone.polygon) include(corner);
  return { minX, minY, maxX, maxY };
}

/** True when every geometry point lies inside the logical canvas. */
export function fitsLogicalCanvas(geometry: IntersectionGeometry): boolean {
  const b = geometryCanvasBounds(geometry);
  return (
    b.minX >= 0 && b.minY >= 0 && b.maxX <= CANVAS_LOGICAL_WIDTH_PX && b.maxY <= CANVAS_LOGICAL_HEIGHT_PX
  );
}

/** Distance from a point to a movement's path (nearest sample); test helper. */
export function distanceToPath(movement: MovementGeometry, point: Vec2): number {
  let best = Infinity;
  for (const sample of movement.samples) {
    const d = vlen(vsub(point, { x: sample.x, y: sample.y }));
    if (d < best) best = d;
  }
  return best;
}
