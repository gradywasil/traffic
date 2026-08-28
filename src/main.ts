/**
 * App entry: boots the U2 application shell (control panel + canvas
 * interactions + playback-controlled simulation loop) with the U3 metrics
 * display (rolling avg-wait chart, headline text readout, engineering
 * overlay) and the O2 optimizer panel (sweep runner + ranked results +
 * one-click apply). All wiring lives in `src/ui/app.ts`; this file only
 * resolves the DOM roots and starts.
 */
import { bootApp } from './ui/app';

function requireCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`#${id} canvas element not found`);
  }
  return element;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`#${id} element not found`);
  }
  return element;
}

function main(): void {
  bootApp({
    canvas: requireCanvas('world'),
    panelContainer: requireElement('controls'),
    chartCanvas: requireCanvas('wait-chart'),
    headlineContainer: requireElement('headline-stats'),
    overlayContainer: requireElement('engineering-overlay'),
    optimizerContainer: requireElement('optimizer'),
  });
}

main();
