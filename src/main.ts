/**
 * App entry: boots the U2 application shell (control panel + canvas
 * interactions + playback-controlled simulation loop) with the U3 metrics
 * display (rolling avg-wait chart, headline text readout, engineering
 * overlay) and the O2 optimizer panel (sweep runner + ranked results +
 * one-click apply). All wiring lives in `src/ui/app.ts`; this file only
 * resolves the DOM roots and starts.
 */
import { bootApp } from './ui/app';
import { showFatalError } from './ui/fatal-error';

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
  try {
    bootApp({
      canvas: requireCanvas('world'),
      panelTopContainer: requireElement('controls-top'),
      panelRestContainer: requireElement('controls-rest'),
      chartCanvas: requireCanvas('wait-chart'),
      headlineContainer: requireElement('headline-stats'),
      overlayContainer: requireElement('engineering-overlay'),
      optimizerContainer: requireElement('optimizer'),
    });
  } catch (error) {
    // Harden: a boot failure (missing root, canvas context refused, …) must
    // explain itself on the page — a blank night-black viewport is the one
    // failure a cold portfolio visitor cannot interpret.
    showFatalError(error, 'the application failed to start');
  }
}

// Harden: every floating promise the app creates settles itself (the
// optimizer's `settle` catches all); one that escapes nonetheless surfaces
// here instead of vanishing into the console of a frozen page.
window.addEventListener('unhandledrejection', (event) => {
  showFatalError(event.reason, 'an unexpected background failure occurred');
});

main();
