/**
 * WCAG 2.x contrast arithmetic (task D1): pure functions to compute relative
 * luminance and contrast ratios for the colors actually painted, so every
 * palette decision is checked programmatically instead of by eyeball (the
 * browser-less environment's stand-in for a visual pass; D1-CHECKLIST.md
 * carries the human eyeball pass).
 *
 * Scope note: this module lives under `src/ui` — OUTSIDE the R2 exact-op
 * sim path (`src/{sim,geom,config}` + the optimizer run modules), so
 * `Math.pow` is fine here; the sim core keeps its whitelist untouched.
 */

/** A parsed CSS color: 8-bit channels plus alpha in [0, 1]. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/**
 * Parse `#rgb`, `#rrggbb`, `rgba(r, g, b, a)` and `rgb(r, g, b)` strings.
 * Throws on anything else — the palette is a closed set, so unknown formats
 * are a programming error, not a runtime condition to tolerate.
 */
export function parseColor(color: string): Rgba {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex !== null && hex[1] !== undefined) {
    const digits = hex[1];
    const at = (index: number): string => {
      const ch = digits[index];
      if (ch === undefined) throw new Error(`bad hex: ${color}`);
      return ch;
    };
    if (digits.length === 3) {
      return {
        r: parseInt(at(0) + at(0), 16),
        g: parseInt(at(1) + at(1), 16),
        b: parseInt(at(2) + at(2), 16),
        a: 1,
      };
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const functional = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (functional !== null) {
    const [, rs, gs, bs, as] = functional;
    if (rs !== undefined && gs !== undefined && bs !== undefined) {
      return { r: Number(rs), g: Number(gs), b: Number(bs), a: as === undefined ? 1 : Number(as) };
    }
  }
  throw new Error(`unparseable color: ${color}`);
}

/** WCAG 2.x relative luminance (spec threshold 0.03928, sRGB transfer). */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors — order-independent, ≥ 1. */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a (possibly translucent) foreground over an opaque background —
 * what the canvas actually rasterizes when a semi-transparent stroke/fill is
 * painted over a surface. Returns an opaque hex string.
 */
export function blendOver(foreground: string, background: string): string {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (bg.a !== 1) throw new Error(`blend background must be opaque: ${background}`);
  const mix = (f: number, b: number): number => Math.round(f * fg.a + b * (1 - fg.a));
  const toHex = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${toHex(mix(fg.r, bg.r))}${toHex(mix(fg.g, bg.g))}${toHex(mix(fg.b, bg.b))}`;
}

/**
 * Contrast of a foreground AS RASTERIZED over the given background: alpha is
 * composited first, then the ratio is computed (a 0.5 white on black is
 * #808080 on black, not white on black).
 */
export function effectiveContrast(foreground: string, background: string): number {
  return contrastRatio(blendOver(foreground, background), background);
}

/** WCAG AA bar for normal-size text (< 18pt / < 14pt bold). */
export const AA_NORMAL_TEXT = 4.5;

/** WCAG AA bar for large text (≥ 18pt) and for meaningful graphics (1.4.11). */
export const AA_LARGE_TEXT_AND_GRAPHICS = 3;
