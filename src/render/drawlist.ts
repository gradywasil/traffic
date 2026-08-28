/**
 * Draw-list contract (task U1): rendering is split into a pure, canvas-free
 * `buildFrame` (deterministic sequence of typed draw commands in logical
 * 1280×720 pixels) and a dumb `paintFrame` executor (painter.ts).
 *
 * Why: there is no headless canvas in this repo's node environment, so the
 * draw list doubles as the rendered-inspection proxy — unit tests (and the
 * throwaway bench) validate structure programmatically: layer order, car
 * command coverage with interpolated positions, control-device state.
 * Layers are ordered background → road → markings → control → cars → hud;
 * the painter ignores `layer`, tests assert monotonicity.
 */
import type { Vec2 } from '../geom';

export type DrawLayer = 'background' | 'road' | 'markings' | 'control' | 'cars' | 'hud';

export const DRAW_LAYER_ORDER: readonly DrawLayer[] = [
  'background',
  'road',
  'markings',
  'control',
  'cars',
  'hud',
];

interface BaseCommand {
  readonly layer: DrawLayer;
}

export interface FillPolygonCommand extends BaseCommand {
  readonly kind: 'fillPolygon';
  readonly points: readonly Vec2[];
  readonly color: string;
  readonly strokeColor?: string;
  readonly strokePx?: number;
}

export interface StrokePolylineCommand extends BaseCommand {
  readonly kind: 'strokePolyline';
  readonly points: readonly Vec2[];
  readonly color: string;
  readonly widthPx: number;
}

export interface FillCircleCommand extends BaseCommand {
  readonly kind: 'fillCircle';
  readonly x: number;
  readonly y: number;
  readonly radiusPx: number;
  readonly color: string;
}

export interface FillRotRoundRectCommand extends BaseCommand {
  readonly kind: 'fillRotRoundRect';
  /** Center in logical px. */
  readonly x: number;
  readonly y: number;
  /** Body rotation in radians (heading angle). */
  readonly angle: number;
  readonly lengthPx: number;
  readonly widthPx: number;
  readonly radiusPx: number;
  readonly color: string;
  readonly strokeColor?: string;
  readonly strokePx?: number;
}

export interface TextCommand extends BaseCommand {
  readonly kind: 'text';
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly fontPx: number;
  /** Horizontal anchor of `x` (task U3: chart axis labels). Default 'left'. */
  readonly align?: 'left' | 'right' | 'center';
}

export type DrawCommand =
  | FillPolygonCommand
  | StrokePolylineCommand
  | FillCircleCommand
  | FillRotRoundRectCommand
  | TextCommand;

export type DrawList = readonly DrawCommand[];

/** Layer rank helper (test-side ordering assertions). */
export function layerRank(layer: DrawLayer): number {
  return DRAW_LAYER_ORDER.indexOf(layer);
}
