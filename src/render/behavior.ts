/**
 * Car behavior classification for rendering (task U1).
 *
 * Maps pure sim state (claim lifecycle phase + kinematics, both already
 * exposed by the F4/F5 layers) onto the four viewer-facing behavior states
 * the plan commits to: cruise / braking-queue / yielding / in-intersection.
 * This is a read-only classification — the renderer never simulates; it only
 * colors what the sim already decided.
 *
 * Derivation rules, in priority order (first match wins):
 *  1. `in-intersection` — claim phase IN_BOX (front bumper past the stop
 *     line, conflict zones not yet fully cleared): the car is crossing the
 *     box under a grant.
 *  2. `yielding` — phase PENDING (holding at/near the line without a grant)
 *     while slow (v < RENDER_YIELD_SPEED_MPS) AND the hold is a right-of-way
 *     wait: an all-way-stop car holding for its FIFO ticket, or a yield
 *     left (permissive-left signal movement / any stop-sign left) waiting
 *     for the τ_clear gap. Signal-red waits are NOT this — they are queue.
 *  3. `braking-queue` — stopped (v < STOPPED_SPEED_MPS, the same threshold
 *     the control layer uses) or decelerating beyond RENDER_BRAKE_EPS_MPS
 *     over the last tick: red-light queues, spillback queues, braking
 *     toward any hold, and comfort slow-downs into turn arcs.
 *  4. `cruise` — everything else: free-flowing at speed (including granted
 *     cars accelerating from the line and cleared cars accelerating out).
 */
import type { TurnDirection } from '../config';
import type { ClaimPhase } from '../sim/control/claims';
import { STOPPED_SPEED_MPS } from '../sim/control/constants';

/** The four plan-committed viewer-facing behavior states. */
export type CarBehavior = 'cruise' | 'braking-queue' | 'yielding' | 'in-intersection';

/** Slow-speed bar below which a PENDING right-of-way hold reads as "yielding". */
export const RENDER_YIELD_SPEED_MPS = 2.0;

/** Per-tick speed drop (m/s) beyond which a car reads as "braking". */
export const RENDER_BRAKE_EPS_MPS = 0.05;

export interface BehaviorInput {
  /** Claim lifecycle phase this tick (undefined record → treat as APPROACH). */
  readonly phase: ClaimPhase | undefined;
  /** End-of-tick speed (m/s). */
  readonly speedMps: number;
  /** Start-of-tick speed (m/s) — deceleration evidence. */
  readonly prevSpeedMps: number;
  /** Control is intersection-wide all-way stop (every line hold is a yield). */
  readonly stopControl: boolean;
  /** This movement is a yield left (permissive-left signal lane / stop-sign left). */
  readonly isYieldLeft: boolean;
}

export function classifyCarBehavior(input: BehaviorInput): CarBehavior {
  if (input.phase === 'in-box') return 'in-intersection';
  if (
    input.phase === 'pending' &&
    (input.stopControl || input.isYieldLeft) &&
    input.speedMps < RENDER_YIELD_SPEED_MPS
  ) {
    return 'yielding';
  }
  if (input.speedMps < STOPPED_SPEED_MPS || input.speedMps < input.prevSpeedMps - RENDER_BRAKE_EPS_MPS) {
    return 'braking-queue';
  }
  return 'cruise';
}

// --- turn-signal lamps (delight pass: the world declares its intentions) ------

/**
 * How far upstream of the stop line a turning car starts signaling (m) —
 * the ~30 m a real driver signals before the intersection, at the canvas's
 * scale the legible zone around the box.
 */
export const TURN_SIGNAL_LEAD_METERS = 28;

/** Blink cadence in SIM time (s): 0.5 s lit / 0.5 s dark ⇒ 1 Hz in-world. */
export const TURN_SIGNAL_PERIOD_SECONDS = 1;

/**
 * Whether turn-signal lamps are lit this frame — a pure function of sim
 * time, so the draw list stays deterministic (same seed ⇒ same blinks) and
 * a paused world holds its lamps honestly.
 */
export function turnSignalLit(timeSeconds: number): boolean {
  return (timeSeconds % TURN_SIGNAL_PERIOD_SECONDS) < TURN_SIGNAL_PERIOD_SECONDS / 2;
}

/**
 * Which turn signal (if any) a car is showing at path position `s`:
 * turning cars signal from `TURN_SIGNAL_LEAD_METERS` before their stop line
 * through the end of the turn curve, then stop (straightened out, blinker
 * off). Through cars never signal. Pure — the renderer only paints what the
 * path geometry already says.
 */
export function classifyTurnSignal(
  turn: TurnDirection,
  sMeters: number,
  stopLineS: number,
  curveEndS: number,
): 'left' | 'right' | null {
  if (turn !== 'left' && turn !== 'right') return null;
  return sMeters >= stopLineS - TURN_SIGNAL_LEAD_METERS && sMeters <= curveEndS ? turn : null;
}
