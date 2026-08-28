/**
 * NEMA-lite fixed-time signal controller (task F5) — research R1 §5.1.
 *
 * Ring: [NS protected left?] → NS through/right → [EW protected left?] →
 * EW through/right, each green followed by a derived yellow and all-red
 * (`phaseChangeIntervals`, task F2: y = t_r + v/(2·a_y); r = (W + len)/v —
 * never configured, never swept). Fixed-time semantics: no phase skipping,
 * empty phases run their duration.
 *
 * The controller is a PURE function of the tick: every stage duration is an
 * exact integer number of ticks (integer-second greens over the 0.1 s grid;
 * change intervals rounded to the grid at config time), so ring transitions
 * land on exact tick boundaries and `stageAtTick(t) === stageAtTick(t +
 * cycleTicks)` identically (R2 Part C: no clocks, no randomness).
 *
 * Grant authority per movement (R1 §4.2 signal gate):
 * - through/right in their axis phase: 'green-protected' / 'yellow-protected';
 * - protected lefts (leftMode 'protected') in their own phase: protected;
 * - permissive lefts (leftMode 'permissive') during their axis through
 *   phase: 'green-yield' / 'yellow-yield' — the claim layer then applies
 *   the deterministic left-yield gate (τ_clear);
 * - yellow: only dilemma-zone-eligible cars may claim (§3.1 rule, owned
 *   here since F5): enter only if v²/(2b) > distance to stop line.
 */
import type { AxisId, IntersectionConfig, SignalPhaseKind, TurnDirection } from '../../config';
import { axisOfArm, phaseChangeIntervals } from '../../config';
import type { IntersectionGeometry } from '../../geom';

export type SignalStageName = 'green' | 'yellow' | 'all-red';

/** One green/yellow/all-red interval of the ring, on the tick grid. */
export interface RingStage {
  readonly phaseIndex: number;
  readonly kind: SignalPhaseKind;
  readonly stage: SignalStageName;
  readonly startTick: number;
  readonly durationTicks: number;
}

export interface SignalTickState {
  readonly stageIndex: number;
  readonly phaseIndex: number;
  readonly kind: SignalPhaseKind;
  readonly stage: SignalStageName;
  readonly tickIntoStage: number;
  /** Ticks left in this stage, counting the current one (>= 1). */
  readonly ticksRemainingInStage: number;
}

/**
 * Grant authority for a movement this tick:
 * - 'none': red — no claims;
 * - 'green-protected' / 'yellow-protected': movement has the right of way
 *   (no yield gate; claims still pass exclusivity + exit headroom);
 * - 'green-yield' / 'yellow-yield': permissive left — claims additionally
 *   pass the left-yield gate (τ_clear) in the claim layer.
 */
export type GrantMode =
  | 'none'
  | 'green-protected'
  | 'green-yield'
  | 'yellow-protected'
  | 'yellow-yield';

/** Indication of the signal head facing one movement (U1 renders these). */
export type SignalColor = 'green' | 'yellow' | 'red';

/** Per-movement facts the authority mapping needs. */
interface MovementSignalInfo {
  readonly axis: AxisId;
  readonly turn: TurnDirection;
  readonly leftPermissive: boolean;
}

const TICK_GRID_EPS = 1e-9;

function ticksForSeconds(seconds: number, dt: number): number {
  const ticks = Math.round(seconds / dt);
  if (Math.abs(ticks * dt - seconds) > TICK_GRID_EPS) {
    throw new Error(
      `signal duration ${String(seconds)} s is not on the ${String(dt)} s tick grid`,
    );
  }
  return ticks;
}

export class SignalController {
  readonly stages: readonly RingStage[];
  readonly cycleTicks: number;

  private readonly config: IntersectionConfig;
  private readonly movementInfos: readonly MovementSignalInfo[];

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig) {
    if (config.control.type !== 'signal') {
      throw new Error(`SignalController requires control.type 'signal'`);
    }
    this.config = config;
    const plan = config.control.plan;
    const dt = config.dt;

    const stages: RingStage[] = [];
    let startTick = 0;
    for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex += 1) {
      const phase = plan.phases[phaseIndex];
      if (phase === undefined) throw new Error(`missing phase ${String(phaseIndex)}`);
      const intervals = phaseChangeIntervals(config, phase.kind);
      const parts: readonly [SignalStageName, number][] = [
        ['green', ticksForSeconds(phase.greenSeconds, dt)],
        ['yellow', ticksForSeconds(intervals.yellowSeconds, dt)],
        ['all-red', ticksForSeconds(intervals.allRedSeconds, dt)],
      ];
      for (const [stage, durationTicks] of parts) {
        if (durationTicks < 1) {
          throw new Error(`stage ${stage} of phase ${String(phaseIndex)} is ${String(durationTicks)} ticks`);
        }
        stages.push({ phaseIndex, kind: phase.kind, stage, startTick, durationTicks });
        startTick += durationTicks;
      }
    }
    this.stages = stages;
    this.cycleTicks = startTick;

    this.movementInfos = geometry.movements.map((movement) => ({
      axis: axisOfArm(movement.arm),
      turn: movement.turn,
      leftPermissive: plan.leftMode[axisOfArm(movement.arm)] === 'permissive',
    }));
  }

  /** Ring state for the interval [tick·dt, (tick+1)·dt). */
  stageAtTick(tick: number): SignalTickState {
    const t = ((Math.trunc(tick) % this.cycleTicks) + this.cycleTicks) % this.cycleTicks;
    for (let stageIndex = 0; stageIndex < this.stages.length; stageIndex += 1) {
      const stage = this.stages[stageIndex];
      if (stage === undefined) throw new Error(`missing stage ${String(stageIndex)}`);
      if (t < stage.startTick + stage.durationTicks) {
        return {
          stageIndex,
          phaseIndex: stage.phaseIndex,
          kind: stage.kind,
          stage: stage.stage,
          tickIntoStage: t - stage.startTick,
          ticksRemainingInStage: stage.startTick + stage.durationTicks - t,
        };
      }
    }
    // cycleTicks is the sum of all stage durations — unreachable.
    throw new Error(`tick ${String(tick)} escaped the signal ring`);
  }

  /** Grant authority for a movement this tick (see `GrantMode`). */
  movementGrantMode(movementIndex: number, tick: number): GrantMode {
    const info = this.movementInfos[movementIndex];
    if (info === undefined) throw new Error(`movement index ${String(movementIndex)} out of range`);
    const state = this.stageAtTick(tick);
    if (state.stage === 'all-red') return 'none';
    const phaseAxis: AxisId =
      state.kind === 'ns-protected-left' || state.kind === 'ns-through-right' ? 'ns' : 'ew';
    if (phaseAxis !== info.axis) return 'none';
    const green = state.stage === 'green';
    const protectedLeftPhase = state.kind === 'ns-protected-left' || state.kind === 'ew-protected-left';
    if (protectedLeftPhase) {
      if (info.turn !== 'left') return 'none';
      return green ? 'green-protected' : 'yellow-protected';
    }
    if (info.turn === 'left') {
      if (!info.leftPermissive) return 'none'; // protected-only outside its own phase
      return green ? 'green-yield' : 'yellow-yield';
    }
    return green ? 'green-protected' : 'yellow-protected';
  }

  /** Signal-head indication for a movement (U1); derived from grant mode. */
  indication(movementIndex: number, tick: number): SignalColor {
    const mode = this.movementGrantMode(movementIndex, tick);
    if (mode === 'none') return 'red';
    if (mode === 'green-protected' || mode === 'green-yield') return 'green';
    return 'yellow';
  }

  /**
   * R1 §3.1 dilemma-zone rule (owned by F5 since this task): a car may
   * legally enter on yellow only if it cannot stop comfortably before the
   * line — v²/(2b) > distance. Also governs barrier erection via the claim
   * layer (an eligible car that is denied a claim still gets the barrier:
   * the b_e envelope stops it safely).
   */
  dilemmaEligible(speedMps: number, distanceToStopLineMeters: number): boolean {
    const b = this.config.modelParams.comfortableDecelMps2;
    return (speedMps * speedMps) / (2 * b) > distanceToStopLineMeters;
  }

  /**
   * Seconds from the start of `tick` until this phase's yellow ends — the
   * window in which a granted car can still reach the stop line. 0 when
   * already inside all-red (no new grants then anyway). Stage boundaries
   * are cycle-relative, so the tick is wrapped into the cycle first.
   */
  secondsUntilYellowEnd(tick: number): number {
    const state = this.stageAtTick(tick);
    let yellowStage: RingStage | undefined;
    if (state.stage === 'yellow') {
      yellowStage = this.stages[state.stageIndex];
    } else if (state.stage === 'green') {
      const next = this.stages[state.stageIndex + 1];
      if (next !== undefined && next.stage === 'yellow') yellowStage = next;
    }
    if (yellowStage === undefined) return 0;
    const t = ((Math.trunc(tick) % this.cycleTicks) + this.cycleTicks) % this.cycleTicks;
    return (yellowStage.startTick + yellowStage.durationTicks - t) * this.config.dt;
  }
}
