/**
 * Canvas picking (task U2): maps a canvas click to the (arm, lane) whose
 * approach it landed on — the canvas-interaction half of the lane editor.
 *
 * The agreed interaction model (town-hall, UX cluster): clicking an arm/lane
 * on the canvas SELECTS it and opens its editor in the DOM panel. There is
 * deliberately no free-form dragging, no painting — geometry edits go through
 * the validated config model (the "lane-configuration model" decision).
 *
 * Hit region: each arm's APPROACH lanes (the side cars queue on — the natural
 * click target), as axis-aligned rectangles from the F3 layout. Clicking the
 * box, an exit lane, or off-road selects nothing (deselect).
 *
 * Pure TypeScript (world-meters math on layout data + the logical↔world px
 * transforms) — unit-testable in node without a DOM.
 */
import type { ArmId } from '../config';
import { ARM_IDS } from '../config';
import type { IntersectionGeometry } from '../geom';
import { CANVAS_CENTER_PX, CANVAS_LOGICAL_HEIGHT_PX, CANVAS_LOGICAL_WIDTH_PX, PX_PER_METER } from '../geom';

export interface ArmLanePick {
  readonly arm: ArmId;
  readonly laneIndex: number;
}

/** Logical canvas pixels → world meters (inverse of `worldToCanvas`). */
export function logicalPxToWorldMeters(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (point.x - CANVAS_CENTER_PX.x) / PX_PER_METER,
    y: (point.y - CANVAS_CENTER_PX.y) / PX_PER_METER,
  };
}

/** CSS-relative pointer coordinates → logical canvas pixels (1280×720 frame). */
export function clientPointToLogicalPx(
  rect: { readonly width: number; readonly height: number; readonly left: number; readonly top: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  return {
    x: ((clientX - rect.left) / width) * CANVAS_LOGICAL_WIDTH_PX,
    y: ((clientY - rect.top) / height) * CANVAS_LOGICAL_HEIGHT_PX,
  };
}

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** AABB of a lane polygon (arms are axis-aligned — rectangles by construction). */
function boundsOf(points: readonly { x: number; y: number }[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Which (arm, approach lane) contains this world point, if any. Arms are
 * tested in canonical order (N, E, S, W); the first containing lane wins —
 * approach rectangles of different arms never overlap by construction.
 */
export function pickArmLane(geometry: IntersectionGeometry, worldPoint: { x: number; y: number }): ArmLanePick | null {
  for (const armId of ARM_IDS) {
    for (const lane of geometry.lanePolygons) {
      if (lane.arm !== armId || lane.side !== 'approach') continue;
      const b = boundsOf(lane.polygon);
      if (
        worldPoint.x >= b.minX &&
        worldPoint.x <= b.maxX &&
        worldPoint.y >= b.minY &&
        worldPoint.y <= b.maxY
      ) {
        return { arm: armId, laneIndex: lane.laneIndex };
      }
    }
  }
  return null;
}
