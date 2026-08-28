/**
 * App glue (task U2): boots the control panel + canvas interactions around
 * the simulation runtime and the U1 renderer, and drives them through the
 * playback-controlled fixed-timestep loop.
 *
 * Pipeline per tick (the F5→F4→F6→F7 order the sim core established):
 * `SimRuntime.step` = control.step → world.step → spawner.step → metrics.
 * Rendering is the U1 draw list at interpolation alpha, plus the U2
 * SELECTION HIGHLIGHT (a stroke around the selected arm's approach lanes —
 * appended after the frame's commands, so it paints on top without touching
 * the pure renderer).
 *
 * Edit-while-running: panel `config-change` events flow into
 * `SimRuntime.applyConfig` (live vs reset semantics documented there).
 * Renderer invalidation: geometry rebuild or control-type/plan change →
 * new `WorldRenderer` (its static road/marking commands and signal-head/
 * stop-sign layout are config-derived); pure demand/plan-green changes keep
 * the renderer (nothing it draws changed).
 *
 * Canvas interactions: a pointer click picks the (arm, approach lane) under
 * it (picking.ts — approach rectangles from the F3 layout) and selects it in
 * the panel model, which reveals/focuses the arm's editor. Clicking anything
 * else (box, exit lanes, off-road) deselects. No dragging, no painting — the
 * agreed lane-configuration model.
 *
 * Metrics display (task U3): the render hook snapshots the F7 engine each
 * frame and hands it to the avg-wait chart + headline text (~1 Hz sim-time
 * gate inside) and the engineering overlay; config changes reset the chart
 * history alongside the stats window.
 */
import type { DrawCommand } from '../render/drawlist';
import { SELECTION_ARM_COLOR, SELECTION_LANE_COLOR } from '../render/colors';
import { configureCanvas, paintFrame } from '../render/painter';
import { WorldRenderer } from '../render/renderer';
import { CANVAS_CENTER_PX, worldToCanvas } from '../geom';
import { getPreset } from '../presets';
import type { ArmId } from '../config';
import { clientPointToLogicalPx, logicalPxToWorldMeters, pickArmLane } from './picking';
import { showFatalError } from './fatal-error';
import { OptimizerModel } from './optimizer/optimizer-model';
import { OptimizerPanel } from './optimizer/optimizer-panel';
import { createOptimizerSweepService } from './optimizer/sweep-service';
import { PanelModel } from './panel-model';
import { PlaybackController } from './playback';
import { SimRuntime } from './sim-runtime';
import { ControlPanel } from './control-panel';
import { MetricsChart } from './chart/metrics-chart';
import { EngineeringOverlay } from './overlay/overlay-panel';

const PRESET_ID = 'balanced';
const MASTER_SEED = 1;
const SELECTION_WIDTH_PX = 2.5;

export interface AppElements {
  readonly canvas: HTMLCanvasElement;
  /** Panel mount ABOVE the optimizer (transport + signal plan). */
  readonly panelTopContainer: HTMLElement;
  /** Panel mount BELOW the optimizer (arms, control type, preset, issues). */
  readonly panelRestContainer: HTMLElement;
  /** U3: rolling avg-wait chart canvas (CSS-sized; DPR handled by the view). */
  readonly chartCanvas: HTMLCanvasElement;
  /** U3: headline text readout container. */
  readonly headlineContainer: HTMLElement;
  /** U3: engineering overlay container (toggle + body). */
  readonly overlayContainer: HTMLElement;
  /** O2: signal timing optimizer (run/cancel/progress/results/apply). */
  readonly optimizerContainer: HTMLElement;
}

/** Rolling-window FPS meter (last ~2 s of frames), refreshed at 4 Hz (F1). */
class FpsMeter {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;
  private readonly refreshIntervalS: number;
  private sinceRefreshS = Infinity;
  fps = 0;
  frameMs = 0;

  constructor(maxSamples = 120, refreshIntervalS = 0.25) {
    this.maxSamples = maxSamples;
    this.refreshIntervalS = refreshIntervalS;
  }

  push(frameDtS: number): void {
    if (frameDtS <= 0) return; // first frame / clamped zero-length
    this.samples.push(frameDtS);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.sinceRefreshS += frameDtS;
    if (this.sinceRefreshS >= this.refreshIntervalS && this.samples.length > 0) {
      const total = this.samples.reduce((sum, dt) => sum + dt, 0);
      this.fps = this.samples.length / total;
      this.frameMs = (total / this.samples.length) * 1000;
      this.sinceRefreshS = 0;
    }
  }
}

export function bootApp(elements: AppElements): void {
  const initialConfig = getPreset(PRESET_ID).config;

  const runtime = new SimRuntime(initialConfig, { masterSeed: MASTER_SEED });
  let renderer = new WorldRenderer(runtime.geometry, runtime.config);
  const model = new PanelModel(initialConfig);
  const meter = new FpsMeter();
  let ctx = configureCanvas(elements.canvas);

  // U3: metrics display — chart + headline text (consumes snapshots only) and
  // the engineering overlay (snapshot + config params, read-only).
  const metricsChart = new MetricsChart({
    canvas: elements.chartCanvas,
    container: elements.headlineContainer,
  });
  const overlay = new EngineeringOverlay(elements.overlayContainer);

  const playback = new PlaybackController({
    fixedDt: runtime.config.dt,
    update: () => {
      runtime.step();
    },
    render: (alpha, frameDt) => {
      const commands = renderer.frame(runtime.world, runtime.control, alpha, {
        fps: meter.fps,
        frameMs: meter.frameMs,
      });
      paintFrame(ctx, appendSelectionHighlight(commands, runtime, model));
      meter.push(frameDt);
      // Metrics display: snapshot each frame (cheap, ~µs at window size) and
      // let the ~1 Hz sim-time gates decide whether anything redraws.
      const snapshot = runtime.metrics.snapshot();
      metricsChart.frame(snapshot);
      overlay.frame(snapshot, runtime.config);
    },
  });

  // O2: optimizer UI — sweeps run on the worker pool off the UI thread; the
  // apply seam routes swept plans through the SAME panel-model commit path
  // as manual edits (validation-gated, one plan-only config-change → live
  // apply + stats reset in the config-change handler below).
  const optimizerModel = new OptimizerModel({
    service: createOptimizerSweepService(),
    getConfig: () => model.config,
    applyPlan: (plan) => model.applySignalPlan(plan),
  });

  model.subscribe((event) => {
    switch (event.type) {
      case 'config-change': {
        const result = runtime.applyConfig(event.config);
        if (result.geometryRebuilt || result.controlChanged) {
          // Static road/markings/heads are config-derived — rebuild them.
          renderer = new WorldRenderer(runtime.geometry, runtime.config);
        }
        // Config change ⇒ stats window reset (F7) ⇒ chart history clears too,
        // so the visible window only ever shows the current regime.
        metricsChart.reset();
        // The optimizer's "current" marker follows the applied plan (applies,
        // manual green edits, presets) — refresh its view of the config.
        optimizerModel.notifyConfigChanged();
        break;
      }
      case 'pause':
        playback.setPaused(event.paused);
        break;
      case 'speed':
        playback.setSpeed(event.speed);
        break;
      case 'select':
        // The panel + canvas highlight consume the model's selection directly.
        break;
    }
  });

  // The panel renders the model and forwards DOM input to model actions.
  // Two mounts in task order: transport + greens above the optimizer,
  // deep config below it (layout pass).
  new ControlPanel(elements.panelTopContainer, elements.panelRestContainer, model);
  new OptimizerPanel(elements.optimizerContainer, optimizerModel);

  elements.canvas.addEventListener('click', (event) => {
    const rect = elements.canvas.getBoundingClientRect();
    const logical = clientPointToLogicalPx(rect, event.clientX, event.clientY);
    const world = logicalPxToWorldMeters(logical);
    const pick = pickArmLane(runtime.geometry, world);
    model.select(pick === null ? null : pick.arm, pick === null ? null : pick.laneIndex);
  });

  window.addEventListener('resize', () => {
    ctx = configureCanvas(elements.canvas);
  });

  // Harden: a throwing frame means the simulation state is suspect — stop
  // the loop and surface ONE honest notice (with the way out) instead of
  // erroring every subsequent frame on the same corrupted state. The frozen
  // world stays on screen under the notice, not blank.
  let loopAlive = true;
  requestAnimationFrame(function frame(timestampMs: number): void {
    if (!loopAlive) return;
    try {
      playback.frame(timestampMs);
    } catch (error) {
      loopAlive = false;
      showFatalError(error, 'the simulation loop failed');
      return;
    }
    requestAnimationFrame(frame);
  });
}

/**
 * Selection highlight commands: a bright stroke around the selected lane (or,
 * for an arm-level selection, around every approach lane of the arm) plus a
 * dim stroke on the arm's other lanes. Appended AFTER the frame so it paints
 * on top of cars and markings.
 */
function appendSelectionHighlight(
  commands: readonly DrawCommand[],
  runtime: SimRuntime,
  model: PanelModel,
): readonly DrawCommand[] {
  const selection = model.selection;
  if (selection.arm === null) return commands;
  const arm: ArmId = selection.arm;
  const highlight: DrawCommand[] = [];
  for (const lane of runtime.geometry.lanePolygons) {
    if (lane.arm !== arm || lane.side !== 'approach') continue;
    const focused = selection.laneIndex === null || selection.laneIndex === lane.laneIndex;
    highlight.push({
      kind: 'strokePolyline',
      layer: 'hud',
      points: [...lane.polygon.map(worldToCanvas), worldToCanvas(lane.polygon[0] ?? CANVAS_CENTER_PX)],
      color: focused ? SELECTION_LANE_COLOR : SELECTION_ARM_COLOR,
      widthPx: SELECTION_WIDTH_PX,
    });
  }
  return [...commands, ...highlight];
}
