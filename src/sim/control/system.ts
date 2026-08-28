/**
 * Control system wiring (task F5): the system that runs BEFORE the F4 car
 * update each tick and feeds it per-car constraints through the
 * `CarConstraints` seam.
 *
 * Per tick (pure function of world state + tick — R2 Part C):
 *   1. `claims.sync` — reconcile per-car claim records with the store;
 *   2. `claims.advanceLifecycles` — request/enter/release transitions and
 *      stop-ticket stamping (stop mode);
 *   3. `claims.evaluateGrants` — the deterministic grant pass, gated by
 *      the signal ring (pure in tick) or the all-way stop tickets;
 *   4. `claims.computeConstraints` — stop-line barriers + exit-lane caps;
 *   5. caller: `world.step(constraints)`.
 *
 * The signal controller holds no mutable clock at all — it is a pure
 * function of the tick — so there is no controller/world tick skew to
 * reason about.
 */
import type { IntersectionConfig } from '../../config';
import type { IntersectionGeometry } from '../../geom';
import type { CarConstraints } from '../store';
import type { CarWorld } from '../world';
import { ClaimManager } from './claims';
import type { AllWayStopController } from './stop';
import { AllWayStopController as AllWayStop } from './stop';
import type { SignalColor, SignalTickState } from './signal';
import { SignalController } from './signal';

export interface ControlSystemOptions {
  /** Constraint buffer size; must be >= the CarWorld capacity (default 512). */
  readonly capacity?: number;
}

export class ControlSystem {
  readonly mode: 'signal' | 'stop';
  /**
   * The active signal controller. Replaceable AT A TICK BOUNDARY via
   * `retargetPlan` (task U2 live apply) — the ring is a pure function of the
   * tick and holds no per-car state, so swapping it never strands a car:
   * already-granted claims keep their zones and complete, and the next
   * `evaluateGrants` pass reads authority from the new ring.
   */
  signal: SignalController | null;
  readonly stop: AllWayStopController | null;
  readonly claims: ClaimManager;
  private readonly geometry: IntersectionGeometry;

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig, options: ControlSystemOptions = {}) {
    this.geometry = geometry;
    if (config.control.type === 'signal') {
      this.mode = 'signal';
      this.signal = new SignalController(geometry, config);
      this.stop = null;
    } else if (config.control.type === 'all-way-stop') {
      this.mode = 'stop';
      this.signal = null;
      this.stop = new AllWayStop();
    } else {
      throw new Error(`unsupported control type`);
    }
    this.claims = new ClaimManager(geometry, config, options.capacity === undefined ? {} : { capacity: options.capacity });
  }

  /**
   * Live signal-plan retarget (task U2): swap in the plan from `next` without
   * rebuilding the claim manager — per-car claim records, zone holds and stop
   * tickets survive; only the ring's authority schedule changes (from the
   * next tick's grant pass onward). The caller must guarantee the geometry
   * and lane structure are unchanged (`SimRuntime.applyConfig` classifies
   * plan-only changes before calling); a control-type switch must rebuild
   * this whole system instead.
   */
  retargetPlan(next: IntersectionConfig): void {
    if (this.mode !== 'signal' || this.signal === null) {
      throw new Error('retargetPlan requires the running control to be a signal');
    }
    if (next.control.type !== 'signal') {
      throw new Error(`retargetPlan requires control.type 'signal', got '${String(next.control.type)}'`);
    }
    this.signal = new SignalController(this.geometry, next);
  }

  /**
   * Advance the control layer by one tick and compute the constraints the
   * car update consumes. Call immediately before `world.step(...)`.
   */
  step(world: CarWorld): CarConstraints {
    const tick = world.tick;
    this.claims.sync(world, this.stop);
    this.claims.advanceLifecycles(world, tick, this.stop);
    this.claims.evaluateGrants(world, tick, this.signal, this.stop);
    return this.claims.computeConstraints(world);
  }

  /** Signal ring state (U1 signal heads; signal mode only). */
  signalState(tick: number): SignalTickState {
    if (this.signal === null) throw new Error('signalState on an all-way-stop control system');
    return this.signal.stageAtTick(tick);
  }

  /** Indication facing one movement ('stop' signs are U1's to draw). */
  indication(movementIndex: number, tick: number): SignalColor | 'stop' {
    if (this.signal !== null) return this.signal.indication(movementIndex, tick);
    return 'stop';
  }
}

export function createControlSystem(
  geometry: IntersectionGeometry,
  config: IntersectionConfig,
  options: ControlSystemOptions = {},
): ControlSystem {
  return new ControlSystem(geometry, config, options);
}
