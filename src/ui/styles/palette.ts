/**
 * Canonical palette + typography (task D1 — the P1 visual decisions settled
 * here). ONE source of truth for every color the app paints, in both worlds:
 *
 * - the DOM shell (index.html's `:root` CSS variables — kept in sync by
 *   `palette.test.ts`, which parses index.html and compares token for token);
 * - the canvas surfaces (the world renderer via `src/render/colors.ts`, the
 *   metrics chart via `src/ui/chart/draw.ts`, the selection highlight in
 *   `src/ui/app.ts`).
 *
 * Contrast discipline: every text pair used anywhere measures ≥ 4.5:1 (WCAG
 * AA normal text) and every meaningful graphic ≥ 3:1 (WCAG 1.4.11), EXCEPT
 * three documented sub-bar pairs (see `SUB_BAR_FLOORS` in palette.test.ts):
 * asphalt-vs-backdrop and the signal-housing fill (silhouettes carried by
 * ≥ 3:1 markings/stroke) and the chart gridlines (reference decoration kept
 * deliberately subordinate to the 9:1 data line). All ratios in the doc
 * comments below were computed by the audit in `palette.test.ts` — the
 * numbers are pinned by tests, not transcribed by hand.
 *
 * Hue system: one blue accent for interaction/selection/data, one amber for
 * "queue/attention", green/yellow/red reserved for signal semantics, neutral
 * slate surfaces everywhere else. Car behavior colors intentionally echo the
 * accent family (cruise ≈ accent) so the moving world and the chrome read as
 * one system.
 */

// --- surfaces & chrome --------------------------------------------------------

/** Page background behind everything (body). */
export const PAGE_BG = '#090b10';

/** Canvas backdrop outside the road + the chart canvas background. */
export const CANVAS_BACKDROP = '#0b0e14';

/** Control-panel surface (also the metrics card). */
export const PANEL_BG = '#10141c';

/** Hairline borders / dividers on panel surfaces. */
export const PANEL_BORDER = '#232a36';

/** Neutral button / arm-bar-track fill on panel surfaces. */
export const BUTTON_BG = '#1a212d';

/** Selected lane-row background. */
export const SELECTED_ROW_BG = '#16202e';

/** Optimizer best-row background. */
export const BEST_ROW_BG = '#16233a';

// --- text ----------------------------------------------------------------------

/** Primary text on panel surfaces (13.5:1 on PANEL_BG). */
export const TEXT_PRIMARY = '#d7dde8';

/** Secondary/label text (6.1:1 on PANEL_BG — AA at its 12 px size). */
export const TEXT_DIM = '#8b95a6';

/** Interaction accent: focus rings, stat values, chart line, selection (8.7:1). */
export const ACCENT = '#6fb7ff';

/** Validation/issue text (7.3:1 on PANEL_BG). */
export const ERROR = '#ff7a7a';

// --- road & markings (canvas) ---------------------------------------------------

/** Asphalt of arms + intersection box. Sub-bar vs backdrop by design (1.4:1):
 *  the road boundary is carried by the edge lines at 7.4:1; raising asphalt
 *  would erode the car/markings contrast that sits on top of it. */
export const ASPHALT = '#282d38';

/** Marking white (edge lines, lane dividers, turn arrows) — painted translucent. */
export const MARKING_WHITE = '#e9eef6';
export const EDGE_LINE_ALPHA = 0.75;
export const LANE_DIVIDER_ALPHA = 0.55;
export const ARROW_ALPHA = 0.85;

/** Double center line (yellow). 7.0:1 on asphalt. */
export const CENTER_LINE = '#e0b23f';

// --- control devices -------------------------------------------------------------

/** Signal-head housing fill; the head silhouette is carried by the stroke. */
export const SIGNAL_HOUSING = '#171b22';

/** Signal-head housing outline — 3.4:1 vs the backdrop (heads sit on the
 *  shoulder off the asphalt), so the head is visible even when lamps are
 *  hidden behind a car at the line. */
export const SIGNAL_HOUSING_STROKE = '#5d687e';

/** Signal lamp colors vs the housing: green 8.6 / yellow 11.7 / red 5.7:1.
 *  Non-color separation (luminance): green-vs-red 1.5, yellow-vs-green 1.4,
 *  yellow-vs-red 2.0 — plus shape (arrow vs ball) and bay position. */
export const SIGNAL_LAMP_GREEN = '#3fd158';
export const SIGNAL_LAMP_YELLOW = '#ffcf3f';
export const SIGNAL_LAMP_RED = '#ff5d5d';

/** All-way-stop octagon: fill 4.1:1 vs backdrop; stroke-on-fill 4.5:1. */
export const STOP_SIGN_FILL = '#d93026';
export const STOP_SIGN_STROKE = '#f5f7fa';

// --- cars -------------------------------------------------------------------------

/** Per-behavior car bodies (vs asphalt: cruise 6.4 / queue 8.9 / yield 5.1 /
 *  in-intersection 9.0 — all ≥ 3:1 graphics bar). */
export const CAR_CRUISE = '#7fb3ff';
export const CAR_BRAKING_QUEUE = '#f2cc60';
export const CAR_YIELDING = '#c77dff';
export const CAR_IN_INTERSECTION = '#7ee787';

/** Car outline: dark body-edge so adjacent queue members stay distinct.
 *  At alpha 0.65 the rasterized outline measures ≥ 4.0:1 against every body
 *  color it outlines (3.4:1 was the pre-D1 0.55-alpha minimum — strengthened
 *  so a 1 px edge reads at the ~940 CSS px layout size). */
export const CAR_STROKE = '#090b10';
export const CAR_STROKE_ALPHA = 0.65;

// --- HUD (canvas overlay text) ------------------------------------------------------

/** HUD sim-readout text (11.8:1 vs backdrop at alpha 0.85). */
export const HUD_TEXT = '#e6ecf5';
export const HUD_TEXT_ALPHA = 0.85;

/** FPS meter semantic colors (vs backdrop: good 12.6 / ok 12.5 / bad 7.7:1). */
export const HUD_GOOD = '#7ee787';
export const HUD_OK = '#f2cc60';
export const HUD_BAD = '#ff7b72';

// --- canvas selection highlight ------------------------------------------------------

/** Selected-lane stroke (6.5:1 vs asphalt). */
export const SELECTION_LANE = '#6fb7ff';

/** Other-lanes-of-the-selected-arm stroke — 3.6:1 vs asphalt (D1 fix: the
 *  pre-D1 #3d5a80 measured 1.95:1, invisible against the asphalt). */
export const SELECTION_ARM = '#6385b0';

// --- chart ---------------------------------------------------------------------------

/** Chart gridlines — deliberately sub-3:1 (measures 2.0:1): reference
 *  decoration whose values are carried by the axis labels (6.4:1 text), kept
 *  subordinate so the 9.1:1 data line dominates. */
export const CHART_GRID = '#384359';

// --- typography ------------------------------------------------------------------------

/** UI text stack (index.html body). */
export const UI_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Numeric-readout stack — every stat value, output, table cell, and all
 * canvas text (HUD, chart labels) uses this. index.html's monospace rules
 * and the canvas painter's MONO_FONT are kept identical to this string by
 * `palette.test.ts`.
 */
export const MONO_FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// --- CSS-variable sync map (index.html :root ⇄ palette) ---------------------------------

/** The CSS variables index.html must define with exactly these token values. */
export const CSS_VARIABLES: Readonly<Record<string, string>> = {
  '--panel-bg': PANEL_BG,
  '--panel-border': PANEL_BORDER,
  '--text': TEXT_PRIMARY,
  '--text-dim': TEXT_DIM,
  '--accent': ACCENT,
  '--error': ERROR,
};

/** Compose a CSS `rgba()` string from a palette token + alpha. */
export function rgba(hex: string, alpha: number): string {
  const digits = hex.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (digits === undefined) throw new Error(`rgba() needs a #rrggbb token: ${hex}`);
  return `rgba(${parseInt(digits.slice(0, 2), 16)}, ${parseInt(digits.slice(2, 4), 16)}, ${parseInt(
    digits.slice(4, 6),
    16,
  )}, ${String(alpha)})`;
}
