/**
 * Per-path free-flow baseline inputs (task F3), implementing research R1
 * §6.1 exactly (influence-zone gates, v_t(p) = min(v_c, sqrt(a_lat·R_p)),
 * closed-form FF(p)). F7 evaluates delays against these; F5's change
 * intervals and F4's turn-speed caps also read them.
 *
 * The canonical unimpeded trajectory through [entry gate, exit gate]:
 *   cruise v_c over L_cruise_in → brake at comfortable b to v_t →
 *   hold v_t from the stop line through the turn curve → accelerate at a →
 *   cruise v_c to the exit gate.
 * R1's formula writes the mid section as L_arc/v_t for arcs that start at
 * the stop line; F3's paths keep the slow section starting exactly at the
 * stop line (curveStartS = stopLineS), so the generalized mid term
 * (curveEndS − stopLineS)/v_t is the faithful closed form — through paths
 * degenerate to (U + box + D)/v_c with v_t = v_c, as R1 intends.
 */

/** v_t(p) = min(v_c, sqrt(a_lat · R_p)); straight paths (R = null) stay at v_c. */
export function turnSpeedMps(cruiseSpeedMps: number, lateralAccelMps2: number, radiusMeters: number | null): number {
  if (radiusMeters === null) return cruiseSpeedMps;
  return Math.min(cruiseSpeedMps, Math.sqrt(lateralAccelMps2 * radiusMeters));
}

/** Entry gate distance U = v_c²/(2b) + v_c·dt + 2 m upstream of the stop line. */
export function entryZoneMeters(cruiseSpeedMps: number, dtSeconds: number, comfortableDecelMps2: number): number {
  return (
    (cruiseSpeedMps * cruiseSpeedMps) / (2 * comfortableDecelMps2) + cruiseSpeedMps * dtSeconds + 2
  );
}

/** Exit gate distance D = (v_c² − v_t²)/(2a) + 2 m past the turn curve end. */
export function exitZoneMeters(cruiseSpeedMps: number, turnSpeed: number, maxAccelerationMps2: number): number {
  return (
    (cruiseSpeedMps * cruiseSpeedMps - turnSpeed * turnSpeed) / (2 * maxAccelerationMps2) + 2
  );
}

export interface FreeFlowProfile {
  /** v_t(p). */
  readonly turnSpeedMps: number;
  /** Entry gate s (stop line minus U). May be negative on extreme configs (flagged as a warning). */
  readonly entryGateS: number;
  /** Exit gate s (curve end plus D). */
  readonly exitGateS: number;
  /** Influence-zone length (exit gate − entry gate); the "free-flow length". */
  readonly influenceZoneMeters: number;
  /** Closed-form free-flow travel time FF(p) through the zone, in seconds. */
  readonly freeFlowSeconds: number;
}

/**
 * FF(p) from geometry s-positions and the model constants:
 *   FF = (U − decelDist)/v_c          cruise in
 *      + (v_c − v_t)/b                comfortable braking
 *      + (curveEndS − stopLineS)/v_t  slow section (gap + turn arc) at v_t
 *      + (v_c − v_t)/a                re-acceleration
 *      + 2/v_c                        cruise out (D − accelDist = 2 m exactly)
 */
export function freeFlowProfile(
  stopLineS: number,
  curveEndS: number,
  turnRadiusMeters: number | null,
  params: {
    readonly dt: number;
    readonly cruiseSpeedMps: number;
    readonly maxAccelerationMps2: number;
    readonly comfortableDecelMps2: number;
    readonly lateralAccelMps2: number;
  },
): FreeFlowProfile {
  const vc = params.cruiseSpeedMps;
  const vT = turnSpeedMps(vc, params.lateralAccelMps2, turnRadiusMeters);
  const b = params.comfortableDecelMps2;
  const a = params.maxAccelerationMps2;
  const U = entryZoneMeters(vc, params.dt, b);
  const decelDist = (vc * vc - vT * vT) / (2 * b);
  const accelDist = (vc * vc - vT * vT) / (2 * a);
  const D = accelDist + 2;
  const entryGateS = stopLineS - U;
  const exitGateS = curveEndS + D;
  const freeFlowSeconds =
    (U - decelDist) / vc +
    (vc - vT) / b +
    (curveEndS - stopLineS) / vT +
    (vc - vT) / a +
    2 / vc;
  if (!(freeFlowSeconds > 0)) {
    throw new Error(`FF(p) must be > 0, got ${String(freeFlowSeconds)} (stopLineS=${String(stopLineS)}, curveEndS=${String(curveEndS)})`);
  }
  return {
    turnSpeedMps: vT,
    entryGateS,
    exitGateS,
    influenceZoneMeters: exitGateS - entryGateS,
    freeFlowSeconds,
  };
}
