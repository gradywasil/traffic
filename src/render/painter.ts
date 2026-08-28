/**
 * Canvas painter (task U1): the dumb executor for `DrawList` commands plus
 * the DPR-aware canvas setup established by F1. No decisions live here —
 * every color/point/width was chosen by the pure renderer; this file only
 * rasterizes, so the deterministic draw list is the single source of what
 * is on screen.
 *
 * The rounded-rect path is built with arcTo (evergreen-safe, no reliance on
 * `ctx.roundRect` availability).
 */
import { CANVAS_LOGICAL_HEIGHT_PX, CANVAS_LOGICAL_WIDTH_PX } from '../geom';
import { MONO_FONT_STACK } from '../ui/styles/palette';
import type { DrawCommand } from './drawlist';
import type { DrawList } from './drawlist';

/** D1 typography: one numeric-readout stack shared by the canvas text and the
 *  panel's monospace rules (index.html) — kept identical by palette.test.ts. */
const MONO_FONT = MONO_FONT_STACK;

/**
 * Size the canvas backing store for `devicePixelRatio` and return its 2-D
 * context (F1 contract). Honors the canvas's laid-out CSS box (task U2: the
 * control-panel layout sizes the canvas below 1280 CSS px) while keeping the
 * 1280×720 LOGICAL coordinate frame — the painter transform is
 * `cssWidth / logicalWidth × dpr`, so a 940 CSS px canvas renders the same
 * draw list proportionally smaller. Falls back to the full logical size when
 * the element has no laid-out box yet.
 */
export function configureCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio ?? 1;
  const cssWidth = canvas.clientWidth || CANVAS_LOGICAL_WIDTH_PX;
  const cssHeight = canvas.clientHeight || Math.round((cssWidth * CANVAS_LOGICAL_HEIGHT_PX) / CANVAS_LOGICAL_WIDTH_PX);
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const scale = (cssWidth / CANVAS_LOGICAL_WIDTH_PX) * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return ctx;
}

/**
 * CSS-pixel canvas setup (task U3, shared per research R3's "share the DPR +
 * resize utility with U1's renderer"): backing store = laid-out CSS box ×
 * devicePixelRatio, transform = dpr, so draw-list coordinates are CSS pixels.
 * Used by the chart canvas, which has no fixed logical frame of its own.
 */
export function configureCanvasDPR(
  canvas: HTMLCanvasElement,
  fallbackWidthPx = 300,
  fallbackHeightPx = 120,
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio ?? 1;
  const cssWidth = canvas.clientWidth || fallbackWidthPx;
  const cssHeight = canvas.clientHeight || fallbackHeightPx;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Execute a draw list onto a configured context, in order. */
export function paintFrame(ctx: CanvasRenderingContext2D, commands: DrawList): void {
  for (const command of commands) {
    paintCommand(ctx, command);
  }
}

function paintCommand(ctx: CanvasRenderingContext2D, command: DrawCommand): void {
  switch (command.kind) {
    case 'fillPolygon': {
      tracePolygon(ctx, command.points);
      ctx.fillStyle = command.color;
      ctx.fill();
      if (command.strokeColor !== undefined && command.strokePx !== undefined) {
        ctx.strokeStyle = command.strokeColor;
        ctx.lineWidth = command.strokePx;
        ctx.stroke();
      }
      break;
    }
    case 'strokePolyline': {
      if (command.points.length < 2) break;
      ctx.strokeStyle = command.color;
      ctx.lineWidth = command.widthPx;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      const first = command.points[0];
      if (first === undefined) break;
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < command.points.length; i += 1) {
        const p = command.points[i];
        if (p !== undefined) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      break;
    }
    case 'fillCircle': {
      ctx.fillStyle = command.color;
      ctx.beginPath();
      ctx.arc(command.x, command.y, command.radiusPx, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'fillRotRoundRect': {
      ctx.save();
      ctx.translate(command.x, command.y);
      ctx.rotate(command.angle);
      traceRoundRect(ctx, command.lengthPx / 2, command.widthPx / 2, command.radiusPx);
      ctx.fillStyle = command.color;
      ctx.fill();
      if (command.strokeColor !== undefined && command.strokePx !== undefined) {
        ctx.strokeStyle = command.strokeColor;
        ctx.lineWidth = command.strokePx;
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'text': {
      ctx.font = `${String(command.fontPx)}px ${MONO_FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = command.align ?? 'left';
      ctx.fillStyle = command.color;
      ctx.fillText(command.text, command.x, command.y);
      break;
    }
  }
}

function tracePolygon(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[]): void {
  ctx.beginPath();
  const first = points[0];
  if (first === undefined) return;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    if (p !== undefined) ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

/** Rounded rect path in a frame already translated/rotated to the body. */
function traceRoundRect(ctx: CanvasRenderingContext2D, halfLength: number, halfWidth: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, halfLength, halfWidth));
  ctx.beginPath();
  ctx.moveTo(-halfLength + r, -halfWidth);
  ctx.arcTo(halfLength, -halfWidth, halfLength, halfWidth, r);
  ctx.arcTo(halfLength, halfWidth, -halfLength, halfWidth, r);
  ctx.arcTo(-halfLength, halfWidth, -halfLength, -halfWidth, r);
  ctx.arcTo(-halfLength, -halfWidth, halfLength, -halfWidth, r);
  ctx.closePath();
}
