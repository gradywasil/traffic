/**
 * D1 contrast + palette-sync audit. The browser-less environment's stand-in
 * for a visual pass: every color pair the app actually paints is measured
 * with the WCAG 2.x formula and pinned at its bar, and the DOM shell's CSS
 * is checked token-for-token against the centralized palette.
 *
 * Three tiers, mirroring WCAG 2.1 AA:
 * - TEXT pairs (≥ 4.5:1) — all UI text is ≤ 14 px, i.e. "normal" size;
 * - GRAPHICS pairs (≥ 3:1, SC 1.4.11) — markings, cars, lamps, chart line,
 *   selection strokes, focus ring;
 * - SUB_BAR_FLOORS — three deliberately sub-3:1 pairs, each pinned at a
 *   documented floor with its rationale (silhouettes carried by ≥ 3:1
 *   companions; gridlines subordinate to the data line by design).
 *
 * Ratios are printed on every run (`npm test`) so the audit table doubles
 * as the recorded evidence for the production log.
 */
import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html?raw';
import controlPanelSource from '../control-panel.ts?raw';
import optimizerPanelSource from '../optimizer/optimizer-panel.ts?raw';
import overlayPanelSource from '../overlay/overlay-panel.ts?raw';
import {
  ARROW_COLOR,
  CAR_BEHAVIOR_COLORS,
  CAR_STROKE_COLOR,
  CENTER_LINE_COLOR,
  EDGE_LINE_COLOR,
  HUD_BAD_COLOR,
  HUD_GOOD_COLOR,
  HUD_OK_COLOR,
  HUD_TEXT_COLOR,
  LANE_DIVIDER_COLOR,
  SELECTION_ARM_COLOR,
  SELECTION_LANE_COLOR,
  SIGNAL_HOUSING_COLOR,
  SIGNAL_HOUSING_STROKE,
  SIGNAL_LAMP_COLORS,
  STOP_SIGN_FILL,
  STOP_SIGN_STROKE,
  ASPHALT_COLOR,
} from '../../render/colors';
import { CHART_BG_COLOR, CHART_LINE_COLOR, CHART_TEXT_DIM_COLOR, CHART_TITLE_COLOR } from '../chart/draw';
import { CHART_GRID } from './palette';
import {
  AA_LARGE_TEXT_AND_GRAPHICS,
  AA_NORMAL_TEXT,
  blendOver,
  contrastRatio,
  effectiveContrast,
  parseColor,
  relativeLuminance,
} from './contrast';
import {
  ACCENT,
  BEST_ROW_BG,
  BUTTON_BG,
  CANVAS_BACKDROP,
  CSS_VARIABLES,
  ERROR,
  MONO_FONT_STACK,
  PAGE_BG,
  PANEL_BG,
  SELECTED_ROW_BG,
  SIGNAL_HOUSING,
  TEXT_DIM,
  TEXT_PRIMARY,
  UI_FONT_STACK,
} from './palette';

// --- contrast arithmetic --------------------------------------------------------

describe('contrast arithmetic (WCAG 2.x formula)', () => {
  it('black vs white is exactly 21:1 and symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 9);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 9);
  });

  it('#767676 on white is the documented 4.54:1 AA normal-text boundary', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('parses #rgb, #rrggbb, rgb() and rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#0b0e14')).toEqual({ r: 11, g: 14, b: 20, a: 1 });
    expect(parseColor('rgb(11, 14, 20)')).toEqual({ r: 11, g: 14, b: 20, a: 1 });
    expect(parseColor('rgba(233, 238, 246, 0.75)')).toEqual({ r: 233, g: 238, b: 246, a: 0.75 });
    expect(() => parseColor('nope')).toThrow();
  });

  it('alpha compositing is exact channel math', () => {
    expect(blendOver('rgba(255,255,255,0.5)', '#000000')).toBe('#808080');
    expect(blendOver('rgba(233,238,246,0)', '#282d38')).toBe('#282d38');
    expect(blendOver('rgba(233,238,246,1)', '#282d38')).toBe('#e9eef6');
  });

  it('effective contrast composites before measuring (translucency cannot buy ratio)', () => {
    // 55% marking white on asphalt is fainter than 75% marking white.
    expect(effectiveContrast('rgba(233,238,246,0.55)', '#282d38')).toBeLessThan(
      effectiveContrast('rgba(233,238,246,0.75)', '#282d38'),
    );
  });

  it('relative luminance matches the spec channel model (white 1, black 0, gray linear-ish)', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 9);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 9);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });
});

// --- the audit --------------------------------------------------------------------

interface AuditPair {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly min: number;
}

/** Text pairs — every piece of text the UI paints, at AA normal-text 4.5:1. */
const TEXT_PAIRS: readonly AuditPair[] = [
  { name: 'panel body text / panel', foreground: TEXT_PRIMARY, background: PANEL_BG, min: AA_NORMAL_TEXT },
  { name: 'panel body text / page bg', foreground: TEXT_PRIMARY, background: PAGE_BG, min: AA_NORMAL_TEXT },
  { name: 'button label / button', foreground: TEXT_PRIMARY, background: BUTTON_BG, min: AA_NORMAL_TEXT },
  { name: 'dim label-hint text / panel (12px)', foreground: TEXT_DIM, background: PANEL_BG, min: AA_NORMAL_TEXT },
  { name: 'stat value + focus ring / panel (14px mono)', foreground: ACCENT, background: PANEL_BG, min: AA_NORMAL_TEXT },
  { name: 'pressed pause-button text / button', foreground: ACCENT, background: BUTTON_BG, min: AA_NORMAL_TEXT },
  { name: 'best badge / best row', foreground: ACCENT, background: BEST_ROW_BG, min: AA_NORMAL_TEXT },
  { name: 'lane-row text / selected row bg', foreground: TEXT_PRIMARY, background: SELECTED_ROW_BG, min: AA_NORMAL_TEXT },
  { name: 'validation issue text / panel', foreground: ERROR, background: PANEL_BG, min: AA_NORMAL_TEXT },
  { name: 'HUD sim readout (composited) / backdrop (14px)', foreground: HUD_TEXT_COLOR, background: CANVAS_BACKDROP, min: AA_NORMAL_TEXT },
  { name: 'HUD fps good / backdrop', foreground: HUD_GOOD_COLOR, background: CANVAS_BACKDROP, min: AA_NORMAL_TEXT },
  { name: 'HUD fps ok / backdrop', foreground: HUD_OK_COLOR, background: CANVAS_BACKDROP, min: AA_NORMAL_TEXT },
  { name: 'HUD fps bad / backdrop', foreground: HUD_BAD_COLOR, background: CANVAS_BACKDROP, min: AA_NORMAL_TEXT },
  { name: 'chart title / chart bg (12px)', foreground: CHART_TITLE_COLOR, background: CHART_BG_COLOR, min: AA_NORMAL_TEXT },
  { name: 'chart axis labels + empty msg / chart bg (11px)', foreground: CHART_TEXT_DIM_COLOR, background: CHART_BG_COLOR, min: AA_NORMAL_TEXT },
];

/** Graphics pairs — SC 1.4.11 meaningful graphics at 3:1. */
const GRAPHICS_PAIRS: readonly AuditPair[] = [
  { name: 'edge lines + stop bars (composited) / asphalt', foreground: EDGE_LINE_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'dashed lane dividers (composited) / asphalt', foreground: LANE_DIVIDER_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'turn arrows (composited) / asphalt', foreground: ARROW_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'double center line / asphalt', foreground: CENTER_LINE_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car cruise / asphalt', foreground: CAR_BEHAVIOR_COLORS.cruise, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car braking-queue / asphalt', foreground: CAR_BEHAVIOR_COLORS['braking-queue'], background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car yielding / asphalt', foreground: CAR_BEHAVIOR_COLORS.yielding, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car in-intersection / asphalt', foreground: CAR_BEHAVIOR_COLORS['in-intersection'], background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  // Adjacent-queue separation: the outline AS RASTERIZED over each body color.
  { name: 'car outline over cruise / cruise body', foreground: blendOver(CAR_STROKE_COLOR, CAR_BEHAVIOR_COLORS.cruise), background: CAR_BEHAVIOR_COLORS.cruise, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car outline over queue / queue body', foreground: blendOver(CAR_STROKE_COLOR, CAR_BEHAVIOR_COLORS['braking-queue']), background: CAR_BEHAVIOR_COLORS['braking-queue'], min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car outline over yield / yield body', foreground: blendOver(CAR_STROKE_COLOR, CAR_BEHAVIOR_COLORS.yielding), background: CAR_BEHAVIOR_COLORS.yielding, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'car outline over in-intersection / body', foreground: blendOver(CAR_STROKE_COLOR, CAR_BEHAVIOR_COLORS['in-intersection']), background: CAR_BEHAVIOR_COLORS['in-intersection'], min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'green lamp / housing', foreground: SIGNAL_LAMP_COLORS.green, background: SIGNAL_HOUSING_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'yellow lamp / housing', foreground: SIGNAL_LAMP_COLORS.yellow, background: SIGNAL_HOUSING_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'red lamp / housing', foreground: SIGNAL_LAMP_COLORS.red, background: SIGNAL_HOUSING_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  // Head silhouette: heads sit on the shoulder, over the backdrop.
  { name: 'signal housing stroke / backdrop', foreground: SIGNAL_HOUSING_STROKE, background: CANVAS_BACKDROP, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'stop-sign fill / backdrop', foreground: STOP_SIGN_FILL, background: CANVAS_BACKDROP, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'stop-sign stroke / stop-sign fill', foreground: STOP_SIGN_STROKE, background: STOP_SIGN_FILL, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'selected-lane stroke / asphalt', foreground: SELECTION_LANE_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'selected-arm stroke / asphalt', foreground: SELECTION_ARM_COLOR, background: ASPHALT_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'chart data line / chart bg', foreground: CHART_LINE_COLOR, background: CHART_BG_COLOR, min: AA_LARGE_TEXT_AND_GRAPHICS },
  { name: 'overlay bar fill / bar track', foreground: ACCENT, background: BUTTON_BG, min: AA_LARGE_TEXT_AND_GRAPHICS },
];

/**
 * Deliberately sub-3:1 pairs, each pinned at a floor with its rationale:
 * - asphalt vs backdrop: the road boundary is carried by 7.4:1 edge lines;
 *   raising asphalt erodes every contrast that sits ON it;
 * - signal housing fill: the head is carried by its 3.4:1 stroke + lamps;
 * - chart gridlines: reference decoration; values are carried by the 6.4:1
 *   axis labels — full 3:1 grid would compete with the 9.1:1 data line.
 */
const SUB_BAR_FLOORS: readonly (AuditPair & { readonly rationale: string })[] = [
  {
    name: 'asphalt / backdrop (boundary via edge lines)',
    foreground: ASPHALT_COLOR,
    background: CANVAS_BACKDROP,
    min: 1.2,
    rationale: 'road silhouette carried by edge lines at 7.4:1',
  },
  {
    name: 'signal housing fill / backdrop (head via stroke + lamps)',
    foreground: SIGNAL_HOUSING,
    background: CANVAS_BACKDROP,
    min: 1.05,
    rationale: 'head silhouette carried by 3.4:1 stroke and 5.7–11.7:1 lamps',
  },
  {
    name: 'chart gridlines / chart bg (reference decoration)',
    foreground: CHART_GRID,
    background: CHART_BG_COLOR,
    min: 1.5,
    rationale: 'values carried by 6.4:1 axis text; grid subordinate by design',
  },
];

describe('D1 contrast audit: text pairs (WCAG AA normal text ≥ 4.5:1)', () => {
  for (const pair of TEXT_PAIRS) {
    it(`${pair.name} ≥ ${String(pair.min)}`, () => {
      const ratio = effectiveContrast(pair.foreground, pair.background);
      console.log(`[D1 audit] ${pair.name}: ${ratio.toFixed(2)}:1`);
      expect(ratio, `${pair.name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
    });
  }
});

describe('D1 contrast audit: graphics pairs (WCAG 1.4.11 ≥ 3:1)', () => {
  for (const pair of GRAPHICS_PAIRS) {
    it(`${pair.name} ≥ ${String(pair.min)}`, () => {
      const ratio = effectiveContrast(pair.foreground, pair.background);
      console.log(`[D1 audit] ${pair.name}: ${ratio.toFixed(2)}:1`);
      expect(ratio, `${pair.name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
    });
  }
});

describe('D1 contrast audit: documented sub-bar floors', () => {
  for (const pair of SUB_BAR_FLOORS) {
    it(`${pair.name} ≥ ${String(pair.min)} (${pair.rationale})`, () => {
      const ratio = contrastRatio(pair.foreground, pair.background);
      console.log(`[D1 audit] ${pair.name}: ${ratio.toFixed(2)}:1 (floor ${String(pair.min)})`);
      expect(ratio, `${pair.name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
    });
  }

  it('lamp hues are also separable by luminance (non-color cue for color-blind users)', () => {
    // Luminance distances between lamps + the arrow-vs-ball shape difference
    // carry signal state without relying on hue alone.
    const pairs: readonly [string, string, string][] = [
      ['green vs red', SIGNAL_LAMP_COLORS.green, SIGNAL_LAMP_COLORS.red],
      ['yellow vs green', SIGNAL_LAMP_COLORS.yellow, SIGNAL_LAMP_COLORS.green],
      ['yellow vs red', SIGNAL_LAMP_COLORS.yellow, SIGNAL_LAMP_COLORS.red],
    ];
    for (const [name, a, b] of pairs) {
      const ratio = contrastRatio(a, b);
      console.log(`[D1 audit] lamp luminance separation ${name}: ${ratio.toFixed(2)}:1`);
      expect(ratio, name).toBeGreaterThanOrEqual(1.3);
    }
  });
});

// --- palette ⇄ DOM shell sync ------------------------------------------------------

describe('D1 palette sync: index.html CSS matches the centralized palette', () => {
  it('defines every CSS variable with the exact palette token value', () => {
    for (const [name, value] of Object.entries(CSS_VARIABLES)) {
      const declaration = indexHtml.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      expect(declaration, `${name} declared in :root`).not.toBeNull();
      expect(declaration?.[1]?.trim(), `${name} = ${value}`).toBe(value);
    }
  });

  it('uses the palette font stacks verbatim (UI + every monospace rule)', () => {
    expect(indexHtml).toContain(`font-family: ${UI_FONT_STACK}`);
    const monoDeclarations = indexHtml.match(/font-family:\s*ui-monospace[^;]+;/g) ?? [];
    expect(monoDeclarations.length, 'monospace rules exist').toBeGreaterThanOrEqual(5);
    for (const declaration of monoDeclarations) {
      expect(declaration, declaration).toBe(`font-family: ${MONO_FONT_STACK};`);
    }
  });

  it('page background matches the palette', () => {
    expect(indexHtml).toContain(`background: ${PAGE_BG}`);
  });
});

// --- DOM-shell accessibility markers (the browser-less structural proxy) ------------

describe('D1 accessibility audit: index.html structural checks', () => {
  it('declares the document language', () => {
    expect(indexHtml).toMatch(/<html\s+lang="en">/);
  });

  it('has exactly one h1 (visually hidden) and an h2 for the metrics section', () => {
    expect(indexHtml.match(/<h1[^>]*>/g)?.length).toBe(1);
    expect(indexHtml).toContain('<h1 class="visually-hidden">Traffic Intersection Flow Simulator</h1>');
    expect(indexHtml).toContain('<h2 class="visually-hidden">Live metrics</h2>');
  });

  it('both canvases are role="img" with aria-labels (canvas not SR-navigable by stance)', () => {
    const canvases = indexHtml.match(/<canvas[\s\S]*?><\/canvas>/g) ?? [];
    expect(canvases.length).toBe(2);
    for (const canvas of canvases) {
      expect(canvas).toContain('role="img"');
      expect(canvas).toMatch(/aria-label="[^"]+"/);
    }
  });

  it('defines a visible :focus-visible style for interactive controls', () => {
    expect(indexHtml).toMatch(/:focus-visible\s*\{/);
  });

  it('wires no inline event handlers (controls are addEventListener-bound TS)', () => {
    expect(indexHtml).not.toMatch(/\son(click|change|input|keydown|load)=/);
  });
});

describe('D1 accessibility audit: control-source checks (label association + live regions)', () => {
  it('control panel associates every native input with an explicit htmlFor label', () => {
    // 6 label-bind sites in control-panel.ts: speed, preset, control type,
    // makeSlider (shared by spawn/mix/greens), lane count, lane checkbox.
    // The pause button needs no label — its text content ("Pause"/"Play")
    // is its accessible name (distill: the old "Simulation" label restated
    // the legend and named nothing new).
    const bindings = controlPanelSource.match(/\.htmlFor\s*=/g) ?? [];
    expect(bindings.length).toBeGreaterThanOrEqual(6);
    // Native control kinds: real range sliders, real checkboxes, real buttons
    // (the arm sections are native details/summary — keyboard-operable and
    // expanded-state-exposing, layout pass).
    expect(controlPanelSource).toContain("input.type = 'range'");
    expect(controlPanelSource).toContain("box.type = 'checkbox'");
    expect(controlPanelSource).toContain("this.pauseButton.type = 'button'");
    expect(controlPanelSource).toContain("h('details', 'arm-section')");
    expect(controlPanelSource).toContain("h('summary', 'arm-summary')");
  });

  it('engineering overlay toggle is a labeled native checkbox', () => {
    expect(overlayPanelSource).toMatch(/toggle\.type = 'checkbox'/);
    expect(overlayPanelSource).toMatch(/toggleLabel\.htmlFor = toggle\.id/);
  });

  it('optimizer progress is a polite live region and blocked applies are alerts', () => {
    expect(optimizerPanelSource).toMatch(/setAttribute\('role', 'status'\)/);
    expect(optimizerPanelSource).toMatch(/setAttribute\('aria-live', 'polite'\)/);
    expect(optimizerPanelSource).toMatch(/setAttribute\('role', 'alert'\)/);
  });

  it('invalid-edit issues announce as an alert region', () => {
    expect(controlPanelSource).toMatch(/setAttribute\('role', 'alert'\)/);
  });
});
