/**
 * Renderer-facing color surface (task U1; re-homed onto the D1 palette).
 *
 * Every value is decided in ONE place — `src/ui/styles/palette.ts`, the
 * D1-centralized palette with programmatically checked contrast ratios
 * (see palette.test.ts) — and this module simply binds those tokens to the
 * names the painter/renderer consume. Colors here are plain CSS color
 * strings (hex or rgba()), never decomposed.
 */
import {
  ARROW_ALPHA,
  ASPHALT,
  CANVAS_BACKDROP,
  CAR_BRAKING_QUEUE,
  CAR_CRUISE,
  CAR_IN_INTERSECTION,
  CAR_STROKE,
  CAR_STROKE_ALPHA,
  CAR_YIELDING,
  CENTER_LINE,
  EDGE_LINE_ALPHA,
  HUD_BAD,
  HUD_GOOD,
  HUD_OK,
  HUD_TEXT,
  HUD_TEXT_ALPHA,
  LANE_DIVIDER_ALPHA,
  MARKING_WHITE,
  SELECTION_ARM,
  SELECTION_LANE,
  SIGNAL_HOUSING,
  SIGNAL_HOUSING_STROKE as HOUSING_STROKE_TOKEN,
  SIGNAL_LAMP_GREEN,
  SIGNAL_LAMP_RED,
  SIGNAL_LAMP_YELLOW,
  STOP_SIGN_FILL as STOP_FILL_TOKEN,
  STOP_SIGN_STROKE as STOP_STROKE_TOKEN,
  rgba,
} from '../ui/styles/palette';

/** Canvas backdrop outside the road (kept from F1's debug renderer). */
export const BACKGROUND_COLOR = CANVAS_BACKDROP;

/** Asphalt of the road surface (arms + intersection box). */
export const ASPHALT_COLOR = ASPHALT;

/** Solid edge lines (outer road boundary) and stop bars. */
export const EDGE_LINE_COLOR = rgba(MARKING_WHITE, EDGE_LINE_ALPHA);

/** Dashed lane dividers between adjacent same-direction lanes. */
export const LANE_DIVIDER_COLOR = rgba(MARKING_WHITE, LANE_DIVIDER_ALPHA);

/** Double center line separating opposing directions. */
export const CENTER_LINE_COLOR = CENTER_LINE;

/** Turn-designation arrows painted on approach lanes. */
export const ARROW_COLOR = rgba(MARKING_WHITE, ARROW_ALPHA);

/** Signal-head housing + lamps. */
export const SIGNAL_HOUSING_COLOR = SIGNAL_HOUSING;
export const SIGNAL_HOUSING_STROKE = HOUSING_STROKE_TOKEN;
export const SIGNAL_LAMP_COLORS = {
  green: SIGNAL_LAMP_GREEN,
  yellow: SIGNAL_LAMP_YELLOW,
  red: SIGNAL_LAMP_RED,
} as const;

/** All-way-stop glyph. */
export const STOP_SIGN_FILL = STOP_FILL_TOKEN;
export const STOP_SIGN_STROKE = STOP_STROKE_TOKEN;

/** Per-behavior car body colors (see `behavior.ts` for the derivation). */
export const CAR_BEHAVIOR_COLORS = {
  cruise: CAR_CRUISE,
  'braking-queue': CAR_BRAKING_QUEUE,
  yielding: CAR_YIELDING,
  'in-intersection': CAR_IN_INTERSECTION,
} as const;

/** Dark outline around car bodies so adjacent queue members stay distinct. */
export const CAR_STROKE_COLOR = rgba(CAR_STROKE, CAR_STROKE_ALPHA);

/** HUD text (FPS meter + sim readout). */
export const HUD_TEXT_COLOR = rgba(HUD_TEXT, HUD_TEXT_ALPHA);
export const HUD_GOOD_COLOR = HUD_GOOD;
export const HUD_OK_COLOR = HUD_OK;
export const HUD_BAD_COLOR = HUD_BAD;

/** Canvas selection highlight (task U2; bound to the palette by D1). */
export const SELECTION_LANE_COLOR = SELECTION_LANE;
export const SELECTION_ARM_COLOR = SELECTION_ARM;
