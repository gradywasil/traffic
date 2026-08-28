/**
 * Simulation runtime (task U2): owns the live world pipeline
 * (control → world → spawner → metrics, the F5/F4/F6/F7 order main.ts
 * established) and implements EDIT-WHILE-RUNNING — config changes applied
 * live at a safe boundary (town-hall §MVP.7, journeys "design"/"tune").
 *
 * ## Geometry-change semantics (the documented decision)
 *
 * A config change is classified against the running config:
 * - `'live'` — only demand (spawn rates, turn mixes) and/or signal-plan
 *   fields (greens, cycle) changed. The cars in flight KEEP GOING: the
 *   spawner is reconfigured in place (RNG stream, pairing digest, round-robin
 *   cursors and virtual entry queues preserved — the demand process changes
 *   its parameters, not its history) and the signal ring is retargeted
 *   (F5's ring is a pure function of the tick; already-granted claims keep
 *   their zones and complete — swapping only the ring never strands a car
 *   inside the box without ownership). Tick/time continue.
 * - `'reset'` — anything geometry-affecting changed: lanes/designations,
 *   per-arm cruise speed, lane width, model params, dt, or the control TYPE
 *   (signal ↔ all-way stop swaps the entire claim regime mid-box — a car in
 *   the intersection under one regime cannot be re-adjudicated safely under
 *   the other). The world is REBUILT at the tick boundary: cars in flight are
 *   dropped, tick/time restart at 0, the spawner re-seeds from the same
 *   master seed (a fresh deterministic run of the new config — same config +
 *   same seed replays identically, Q1's contract), geometry/renderer inputs
 *   are rebuilt. Cars in flight during incompatible geometry changes is a
 *   correctness hazard (paths that no longer exist, zones that moved); the
 *   reset is the safe option.
 * - Metrics reset fires on BOTH paths (F7's config-change signal): 'live'
 *   calls `MetricsEngine.reset()` (in-flight trips re-baseline, excluded
 *   from aggregates); 'reset' builds a fresh engine.
 *
 * ## Determinism contract (R2 Part C)
 *
 * `applyConfig` may only run BETWEEN ticks — enforced by a reentrancy guard
 * (`step` and `applyConfig` mutually exclude). The run is therefore a pure
 * function of (initial config, seed, the ordered list of config changes with
 * their tick positions): the same script replays bit-identically (tested).
 * The DOM panel emits configs from input events, which the single-threaded
 * event loop always delivers outside `step`, so the boundary holds in the
 * app without extra machinery.
 */
import { ARM_IDS, validateConfig } from '../config';
import type { IntersectionConfig } from '../config';
import { buildIntersectionGeometry } from '../geom';
import type { IntersectionGeometry } from '../geom';
import { stableStringify } from '../geom';
import { createControlSystem } from '../sim/control';
import type { ControlSystem } from '../sim/control';
import { MetricsEngine } from '../sim/metrics';
import { Spawner } from '../sim/spawn';
import { createCarWorld } from '../sim/world';
import type { CarWorld } from '../sim/world';

/** What a config change means for the running world (see module doc). */
export type ConfigChangeScope = 'none' | 'live' | 'reset';

export interface ApplyConfigResult {
  readonly scope: ConfigChangeScope;
  /** True when geometry was rebuilt (renderer statics must be rebuilt too). */
  readonly geometryRebuilt: boolean;
  /** True when the control config changed (renderer heads/signs + authority). */
  readonly controlChanged: boolean;
  /** The tick the new config takes effect from (the boundary it was applied at). */
  readonly appliedAtTick: number;
}

/**
 * Classify `next` against `prev`. Everything except demand (spawn rate, turn
 * mix) and signal-plan greens/cycle/leftMode is geometry-affecting and forces
 * a world reset; an identical config is 'none'.
 */
export function classifyConfigChange(prev: IntersectionConfig, next: IntersectionConfig): ConfigChangeScope {
  if (prev === next) return 'none';
  if (stableStringify(prev) === stableStringify(next)) return 'none';
  const coreUnchanged =
    prev.dt === next.dt &&
    stableStringify(prev.geometry) === stableStringify(next.geometry) &&
    stableStringify(prev.modelParams) === stableStringify(next.modelParams) &&
    prev.control.type === next.control.type &&
    ARM_IDS.every((arm) => {
      const prevArm = prev.arms[arm];
      const nextArm = next.arms[arm];
      return (
        prevArm.cruiseSpeedMps === nextArm.cruiseSpeedMps &&
        stableStringify(prevArm.lanes) === stableStringify(nextArm.lanes)
      );
    });
  return coreUnchanged ? 'live' : 'reset';
}

export interface SimRuntimeOptions {
  /** Master run seed S (uint32; F6). Default 1. */
  readonly masterSeed?: number;
  /** Car capacity of the world + constraint buffers (default 512). */
  readonly capacity?: number;
}

export class SimRuntime {
  readonly masterSeed: number;
  private readonly capacity: number;

  private geometryState: IntersectionGeometry;
  private configState: IntersectionConfig;
  private worldState: CarWorld;
  private controlState: ControlSystem;
  private spawnerState: Spawner;
  private metricsState: MetricsEngine;
  private stepping = false;

  constructor(config: IntersectionConfig, options: SimRuntimeOptions = {}) {
    this.masterSeed = (options.masterSeed ?? 1) | 0;
    this.capacity = options.capacity ?? 512;
    const issues = validateConfig(config);
    if (issues.length > 0) {
      throw new Error(`SimRuntime config is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    }
    this.geometryState = buildIntersectionGeometry(config);
    this.configState = config;
    this.worldState = createCarWorld(this.geometryState, config, { capacity: this.capacity });
    this.controlState = createControlSystem(this.geometryState, config, { capacity: this.capacity });
    this.spawnerState = new Spawner(this.geometryState, config, { masterSeed: this.masterSeed });
    this.metricsState = new MetricsEngine(this.geometryState, config);
  }

  get geometry(): IntersectionGeometry {
    return this.geometryState;
  }

  get config(): IntersectionConfig {
    return this.configState;
  }

  get world(): CarWorld {
    return this.worldState;
  }

  get control(): ControlSystem {
    return this.controlState;
  }

  get spawner(): Spawner {
    return this.spawnerState;
  }

  get metrics(): MetricsEngine {
    return this.metricsState;
  }

  /** Advance exactly one fixed tick: control → world → spawner → metrics. */
  step(): void {
    if (this.stepping) throw new Error('SimRuntime.step is not reentrant');
    this.stepping = true;
    try {
      const constraints = this.controlState.step(this.worldState);
      this.worldState.step(constraints);
      this.spawnerState.step(this.worldState);
      this.metricsState.observe(this.worldState, this.spawnerState.trips);
    } finally {
      this.stepping = false;
    }
  }

  /**
   * Apply a validated config change at this tick boundary (see module doc
   * for the live-vs-reset semantics). Throws on an invalid config — the
   * panel model is the friendly-flagging layer; the runtime is the guard.
   */
  applyConfig(next: IntersectionConfig): ApplyConfigResult {
    if (this.stepping) throw new Error('applyConfig must run at a tick boundary, not inside step');
    const issues = validateConfig(next);
    if (issues.length > 0) {
      throw new Error(`cannot apply invalid config: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    }
    const scope = classifyConfigChange(this.configState, next);
    if (scope === 'none') {
      return { scope, geometryRebuilt: false, controlChanged: false, appliedAtTick: this.worldState.tick };
    }
    if (scope === 'live') {
      const controlChanged = stableStringify(this.configState.control) !== stableStringify(next.control);
      if (controlChanged && next.control.type === 'signal') {
        // Same control type (scope 'live' guarantees it) with a changed plan:
        // swap the pure-in-tick ring, keep every per-car claim record.
        this.controlState.retargetPlan(next);
      }
      this.spawnerState.reconfigure(next);
      this.metricsState.reset();
      this.configState = next;
      return { scope, geometryRebuilt: false, controlChanged, appliedAtTick: this.worldState.tick };
    }
    // 'reset': fresh deterministic run of the new config, same master seed.
    this.geometryState = buildIntersectionGeometry(next);
    this.configState = next;
    this.worldState = createCarWorld(this.geometryState, next, { capacity: this.capacity });
    this.controlState = createControlSystem(this.geometryState, next, { capacity: this.capacity });
    this.spawnerState = new Spawner(this.geometryState, next, { masterSeed: this.masterSeed });
    this.metricsState = new MetricsEngine(this.geometryState, next);
    return { scope, geometryRebuilt: true, controlChanged: true, appliedAtTick: 0 };
  }
}
