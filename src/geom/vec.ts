/**
 * Minimal 2-D vector helpers for intersection geometry (task F3).
 *
 * Convention: world coordinates are meters in the canvas' logical frame —
 * +x east, +y south (screen coordinates, y down), origin at the intersection
 * center. Renderers map this frame onto the 1280×720 canvas (see constants).
 *
 * Numeric hygiene: only IEEE-exact ops plus `sqrt` are used anywhere in
 * `src/geom/` (research R2's rulebook is scoped to `src/sim/`, but geometry
 * feeds the run-hash world later, so it stays whitelist-clean by choice —
 * no trig, no `pow`, no `log`).
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function v2(x: number, y: number): Vec2 {
  return { x, y };
}

export function vadd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vscale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function vneg(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y };
}

export function vdot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function vlen(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function vnormalize(a: Vec2): Vec2 {
  const l = vlen(a);
  if (!(l > 0)) throw new Error('cannot normalize a zero-length vector');
  return { x: a.x / l, y: a.y / l };
}

export function vlerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The right-hand side of a driver traveling along unit heading `d` in the
 * screen frame (y down). Heading east (1,0) → right is south (0,1).
 * Right-hand traffic: approach/exit lanes stack toward this side.
 */
export function rightOf(d: Vec2): Vec2 {
  return { x: -d.y, y: d.x };
}

/** Left-hand side of a driver traveling along `d` (see `rightOf`). */
export function leftOf(d: Vec2): Vec2 {
  return { x: d.y, y: -d.x };
}

/** Provably-in-range array access for deterministic construction code. */
export function itemAt<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`index ${index} out of bounds (length ${items.length})`);
  return value;
}
