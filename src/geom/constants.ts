/**
 * Geometry constants (task F3).
 *
 * Split by authority:
 * - Lane width, model parameters, dt come from `IntersectionConfig`
 *   (research R1 §3.1 commits their defaults; F2 owns them).
 * - Everything below is production-owned (plan risk note: "geometry constants
 *   become visual-design inputs, P1") except where a research commitment pins
 *   a constraint — documented inline.
 *
 * Arm length 120 m satisfies R1 §6.1/§8: approach arm ≥ U + queue storage
 * (U ≈ 51.7 m at v_c = 13.9, b = 2.0; storage ≈ 50 m ⇒ ~9 queued cars/arm)
 * and exit arm ≥ D (≤ ~77 m past the turn arc at defaults).
 */
import type { TurnDirection } from '../config';

/** Logical canvas the geometry must fit (scope: ≥1280×720 viewport). */
export const CANVAS_LOGICAL_WIDTH_PX = 1280;
export const CANVAS_LOGICAL_HEIGHT_PX = 720;

/**
 * Render scale: the world extent is 240×240 m (2 × armLength), so 2.9 px/m
 * gives 696×696 px — 12 px vertical margin, and a 3.5 m lane reads as
 * ~10 px (clearly visible), a 5 m car as ~14.5 px.
 */
export const PX_PER_METER = 2.9;

/** World origin (intersection center) in logical canvas pixels. */
export const CANVAS_CENTER_PX = { x: CANVAS_LOGICAL_WIDTH_PX / 2, y: CANVAS_LOGICAL_HEIGHT_PX / 2 } as const;

/** Arm length in meters, measured from the intersection center to the road end. */
export const ARM_LENGTH_METERS = 120;

/**
 * View zoom that fills the canvas WIDTH with the road (240 m arm-to-arm =
 * 696 logical px): 1280 / 696 ≈ 1.839. The mobile canvas (adapt pass) trades
 * the full-world overview for this crop — the E–W road runs edge to edge and
 * the N/S arm tips extend past the top and bottom of the frame.
 */
export const ROAD_FILL_WIDTH_ZOOM = CANVAS_LOGICAL_WIDTH_PX / (2 * ARM_LENGTH_METERS * PX_PER_METER);

/**
 * Stop-line setback from the box edge (meters). Models the crosswalk strip
 * real intersections leave before the conflict area, and sets the right-turn
 * radius: with 3.5 m lanes the right-turn arc comes out at S + lw/2 = 7.75 m
 * → v_turn ≈ 3.6 m/s ≈ 13 km/h, a believable urban right-turn speed.
 */
export const STOP_LINE_SETBACK_METERS = 6;

/** Queue storage every approach must offer beyond the entry gate U (R1 §6.1). */
export const MIN_QUEUE_STORAGE_METERS = 50;

/**
 * Car width (m). R1 §3.1 commits the 5.0 m length and notes width is "for
 * render/claim padding only" — this constant owns that width. Feeds the
 * capsule footprints used for conflict-zone padding.
 */
export const CAR_WIDTH_METERS = 1.8;

/** Path polyline sampling step (m). Chord error at the tightest arc
 * (R = 7.75 m) is < 0.001 m; s is accumulated chord length, so car-following
 * (dt = 0.1 s) steps along exactly the polyline a car renders on. */
export const PATH_SAMPLE_STEP_METERS = 0.25;

/** Conflict scanning decimates path samples by this stride (0.5 m effective). */
export const CONFLICT_SAMPLE_STRIDE = 2;

/** How far before the stop line conflict scanning starts (car length + margin). */
export const CONFLICT_SEARCH_BACK_METERS = 8;

/** How far past the turn-curve end merge zones are searched on the exit arm. */
export const EXIT_MERGE_SPAN_METERS = 60;

/** Gaps between conflicting sample runs smaller than this merge into one zone. */
export const ZONE_RUN_MERGE_GAP_METERS = 1;

/** Conservative outward padding of zone polygons (≥ car width + scan step). */
export const ZONE_POLYGON_PAD_METERS = 2.5;

/**
 * Tolerance for a turn arc clipping the road's square corner (m). Default
 * geometry clips ≈ 0.74 m (≈ 2 px) — invisible; larger clips warn so U1 can
 * round drawn curbs.
 */
export const CORNER_CLIP_TOLERANCE_METERS = 1;

/** Minimum lateral-jog span for through movements on misaligned lane counts. */
export const JOG_MIN_SPAN_METERS = 32;

/** Jog landing must leave this much exit arm beyond it (despawn headroom). */
export const EXIT_MARGIN_METERS = 12;

/** Canonical movement enumeration order within a lane (also FIFO-friendly). */
export const MOVEMENT_TURN_ORDER: readonly TurnDirection[] = ['left', 'through', 'right'];
