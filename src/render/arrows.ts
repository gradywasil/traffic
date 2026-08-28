/**
 * Per-lane turn-designation arrow glyphs (task U1), painted on approach
 * lanes upstream of the stop line.
 *
 * Geometry lives in a lane-local frame in meters: +x along the travel
 * direction (the approach's inbound heading), +y toward the driver's right
 * (rightOfInbound). The glyph must fit the lane's width — `maxAbsLateral`
 * is asserted against half the lane width in tests (default lanes: 3.5 m →
 * |y| ≤ 1.75).
 *
 * Primitive-but-clear pavement-marking shapes:
 * - through: straight shaft + triangular head at its end;
 * - left/right: shorter shaft, a lateral bend, and a head pointing to the
 *   turn side;
 * - shared lanes (multiple designations): one full-length shaft, the
 *   through head (if served) at its end, plus a bend+head branching from
 *   mid-shaft per served turn side.
 */
import type { TurnDirection } from '../config';
import type { Vec2 } from '../geom';

export interface ArrowGlyph {
  /** Stroke polylines in lane-local meters. */
  readonly strokes: readonly (readonly Vec2[])[];
  /** Fill triangles (arrow heads) in lane-local meters. */
  readonly heads: readonly (readonly Vec2[])[];
  /** Largest |y| the glyph reaches (lane-fit check). */
  readonly maxAbsLateral: number;
}

// Single-designation glyphs.
const THROUGH_HEAD: readonly Vec2[] = [
  { x: 4.0, y: -0.95 },
  { x: 4.0, y: 0.95 },
  { x: 5.5, y: 0 },
];
const LEFT_HEAD: readonly Vec2[] = [
  { x: 2.15, y: -1.0 },
  { x: 3.45, y: -1.0 },
  { x: 2.8, y: -1.7 },
];

// Branch geometry for shared lanes (attaches at mid-shaft x = 2.2).
const BRANCH_X = 2.2;
const LEFT_BRANCH_HEAD: readonly Vec2[] = [
  { x: 1.55, y: -1.0 },
  { x: 2.85, y: -1.0 },
  { x: BRANCH_X, y: -1.65 },
];

function mirror(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x, y: -p.y }));
}

/**
 * Build the arrow glyph for one lane's designations. Deterministic: output
 * order is shaft → left parts → through head → right parts.
 */
export function laneArrowGlyph(designations: readonly TurnDirection[]): ArrowGlyph {
  const left = designations.includes('left');
  const through = designations.includes('through');
  const right = designations.includes('right');
  if (designations.length === 0) {
    throw new Error('lane arrow requires at least one designation');
  }

  const strokes: Vec2[][] = [];
  const heads: Vec2[][] = [];
  const shared = designations.length > 1;

  if (!shared) {
    if (through) {
      strokes.push([
        { x: 0.3, y: 0 },
        { x: 4.0, y: 0 },
      ]);
      heads.push([...THROUGH_HEAD]);
    } else if (left) {
      strokes.push([
        { x: 0.3, y: 0 },
        { x: 2.8, y: 0 },
        { x: 2.8, y: -1.0 },
      ]);
      heads.push([...LEFT_HEAD]);
    } else {
      strokes.push([
        { x: 0.3, y: 0 },
        { x: 2.8, y: 0 },
        { x: 2.8, y: 1.0 },
      ]);
      heads.push(mirror(LEFT_HEAD));
    }
  } else {
    strokes.push([
      { x: 0.3, y: 0 },
      { x: 4.0, y: 0 },
    ]);
    if (left) {
      strokes.push([
        { x: BRANCH_X, y: 0 },
        { x: BRANCH_X, y: -1.0 },
      ]);
      heads.push([...LEFT_BRANCH_HEAD]);
    }
    if (through) {
      heads.push([...THROUGH_HEAD]);
    }
    if (right) {
      strokes.push([
        { x: BRANCH_X, y: 0 },
        { x: BRANCH_X, y: 1.0 },
      ]);
      heads.push(mirror(LEFT_BRANCH_HEAD));
    }
  }

  let maxAbsLateral = 0;
  for (const line of strokes) {
    for (const p of line) maxAbsLateral = Math.max(maxAbsLateral, Math.abs(p.y));
  }
  for (const head of heads) {
    for (const p of head) maxAbsLateral = Math.max(maxAbsLateral, Math.abs(p.y));
  }
  return { strokes, heads, maxAbsLateral };
}

/**
 * Transform a glyph into world meters: `origin` = the glyph's local (0, 0)
 * (tail), `u` = unit travel heading (+x), `r` = unit right-of-travel (+y).
 */
export function arrowGlyphToWorld(
  glyph: ArrowGlyph,
  origin: Vec2,
  u: Vec2,
  r: Vec2,
): { strokes: Vec2[][]; heads: Vec2[][] } {
  const toWorld = (p: Vec2): Vec2 => ({
    x: origin.x + u.x * p.x + r.x * p.y,
    y: origin.y + u.y * p.x + r.y * p.y,
  });
  return {
    strokes: glyph.strokes.map((line) => line.map(toWorld)),
    heads: glyph.heads.map((tri) => tri.map(toWorld)),
  };
}
