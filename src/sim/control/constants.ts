/**
 * Control-layer constants (task F5) — research R1 §4.2 grant-rule defaults
 * plus the production-owned tolerances the arbitration needs. Everything
 * here is P1-tunable; the values are the committed defaults.
 */

/**
 * τ_clear (R1 §4.2 grant rule 3): a left under yield authority may only
 * claim when no oncoming car's worst-case arrival at the shared conflict
 * zone is within this window (worst case = the oncoming car accelerates to
 * v_c immediately). Default 4.0 s.
 */
export const TAU_CLEAR_SECONDS = 4.0;

/**
 * Claims release only after the holder's rear bumper clears its last
 * conflict zone by this margin (R1 §4.2 IN_BOX → CLEARED, "+ margin").
 */
export const CLAIM_RELEASE_MARGIN_METERS = 0.5;

/**
 * A car requests (APPROACH → PENDING) once the stop line is within its
 * comfortable stopping distance at the current speed plus this margin and
 * one tick of travel (R1 §4.2: "request distance ≥ stopping distance at
 * current speed, so denial ⇒ car stops at the line via the virtual
 * leader"). At v_c this reproduces the F3 entry gate U ≈ 51.7 m.
 */
export const REQUEST_MARGIN_METERS = 2.0;

/** A car counts as stopped for stop-sign tickets / signal FIFO timestamps. */
export const STOPPED_SPEED_MPS = 0.5;

/** Front bumper within this window of the stop line counts as "at the line". */
export const STOP_LINE_WINDOW_METERS = 2.5;

/**
 * Signal grants additionally require that the car can still reach the stop
 * line before the phase's yellow ends (imminent-entry rule; keeps claims
 * from being held across the whole red by cars that cannot enter in time).
 * Speed assumed for a crawling/queued car's remaining approach.
 */
export const MIN_GRANT_APPROACH_SPEED_MPS = 2.0;

/**
 * Front-bumper slack for "has not yet crossed the stop line". Covers the
 * IDM settling overshoot: a car held by the stop-line barrier (at
 * stopLineS + s0) can creep past the line by up to s0 − s_min = 1.5 m
 * before its discrete ballistic stop completes; the terminal clamp bounds
 * the excursion there, so 2.0 m makes "crossed without a grant" (counted
 * separately) impossible by construction.
 */
export const ENTER_SLACK_METERS = 2.0;
