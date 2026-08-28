/**
 * World renderer (task U1): assembles the frame's draw list from pure sim
 * state — never simulates. Split cleanly:
 *
 * - `buildScene` reads the CarWorld (interpolated poses at render alpha via
 *   `carPose`, the F1 prev/curr contract) and the ControlSystem (signal
 *   indications at the current tick; claim phases for behavior coloring);
 * - `buildFrame` emits the ordered command list: static road/markings/
 *   arrows (built once in the constructor — pure functions of geometry +
 *   config), then per-frame control devices (signal heads / stop signs),
 *   cars as oriented rounded rectangles colored by behavior, and the HUD.
 *
 * Signal heads: ONE compact head PER APPROACH LANE on the right shoulder,
 * with up to two lamps — an arrow lamp for the lane's left designation and
 * a ball lamp for through/right — each lit with that movement's current
 * indication (`SignalController.indication`). Through and right always
 * share an indication (same authority class in the ring), so ≤2 lamps cover
 * every config; a shared left+through lane under a protected axis shows a
 * red arrow beside a green ball honestly (the shared lane's left is red
 * outside its own phase). This is per-movement rendering at lane-head
 * fidelity — documented as the chosen middle ground.
 *
 * All-way stop: one STOP octagon per arm on the right shoulder at the stop
 * line; no signal heads.
 *
 * Camera is the fixed F3 fit (worldToCanvas, 1280×720 logical, DPR handled
 * by the painter). Trig/rounding are free to live here — the R2 exact-op
 * rulebook scopes `src/render/` as render-only territory.
 */
import type { ArmId, IntersectionConfig, TurnDirection } from '../config';
import { ARM_IDS, axisOfArm } from '../config';
import type { IntersectionGeometry, Vec2 } from '../geom';
import { CAR_WIDTH_METERS, PX_PER_METER } from '../geom';
import { itemAt, vadd, vscale } from '../geom';
import { worldToCanvas } from '../geom';
import type { ControlSystem } from '../sim/control/system';
import type { SignalColor } from '../sim/control/signal';
import { f64At, i32At } from '../sim/store';
import type { CarWorld } from '../sim/world';
import { arrowGlyphToWorld, laneArrowGlyph } from './arrows';
import { classifyCarBehavior } from './behavior';
import type { CarBehavior } from './behavior';
import {
  ARROW_COLOR,
  ASPHALT_COLOR,
  BACKGROUND_COLOR,
  CAR_BEHAVIOR_COLORS,
  CAR_STROKE_COLOR,
  CENTER_LINE_COLOR,
  EDGE_LINE_COLOR,
  HUD_BAD_COLOR,
  HUD_GOOD_COLOR,
  HUD_OK_COLOR,
  HUD_TEXT_COLOR,
  LANE_DIVIDER_COLOR,
  SIGNAL_HOUSING_COLOR,
  SIGNAL_HOUSING_STROKE,
  SIGNAL_LAMP_COLORS,
  STOP_SIGN_FILL,
  STOP_SIGN_STROKE,
} from './colors';
import type { DrawCommand, DrawList } from './drawlist';
import { buildMarkings } from './markings';

/** Arrow-tail distance upstream of the stop line (m). */
export const ARROW_TAIL_BEFORE_STOP_METERS = 10;

// --- visual constants (logical px; P1 settled at D1) ---------------------------
const EDGE_LINE_PX = 1.6;
const CENTER_LINE_PX = 1.1;
const LANE_DIVIDER_PX = 1.1;
const STOP_BAR_PX = 1.5;
// D1 legibility pass: the canvas lays out at ~940 CSS px next to the 340 px
// panel (scale ≈ 0.73), so a 1.2 px arrow stroke rasterized to ~0.9 px. 1.6
// keeps pavement glyphs ≥ 1 px of painted width at the app's real layout size
// (arrow fill already measures 9.0:1 vs asphalt — this is about stroke mass).
const ARROW_STROKE_PX = 1.6;
// D1 signal-head visibility: heads enlarged ~20% (ball r 2.9 → 3.5, arrow tip
// 3.8 → 4.5) and the housing stroke strengthened to 1.2 px at 3.4:1 vs the
// backdrop (palette token) — a head stayed findable when its lamp was the
// same hue family as a car behind it.
const HEAD_WIDTH_PX = 12;
const HEAD_BAY_SPACING_PX = 10;
const HEAD_BAY_PAD_PX = 5.5;
const HEAD_BALL_RADIUS_PX = 3.5;
const HEAD_ARROW_TIP_PX = 4.5;
const HEAD_ARROW_BASE_PX = 2.5;
const HEAD_HOUSING_STROKE_PX = 1.2;
const STOP_SIGN_RADIUS_PX = 6.2;
const STOP_SIGN_STROKE_PX = 1.4;
const HUD_FONT_PX = 14;

/** Signal-head anchor: lateral offset beyond the road edge (m). */
const HEAD_LATERAL_METERS = 3.4;
/** Signal-head anchor: longitudinal offset upstream of the stop line (m). */
const HEAD_LONGITUDINAL_METERS = 2.2;
/** Per-lane stagger between successive lane heads along the arm (m). */
const HEAD_STAGGER_METERS = 3.6;

export interface SceneCar {
  readonly entityId: number;
  /** Body-center world position (pose is front-bumper; center backs off len/2). */
  readonly x: number;
  readonly y: number;
  readonly hx: number;
  readonly hy: number;
  readonly lengthMeters: number;
  readonly speedMps: number;
  readonly behavior: CarBehavior;
}

export interface SceneHud {
  readonly fps: number;
  readonly frameMs: number;
}

export interface RenderScene {
  readonly timeSeconds: number;
  readonly tick: number;
  readonly controlType: 'signal' | 'all-way-stop';
  readonly cars: readonly SceneCar[];
  /** Per-movement-index signal indication; null under all-way stop. */
  readonly indications: readonly SignalColor[] | null;
  readonly hud: SceneHud | null;
}

interface LaneHeadLayout {
  readonly arm: ArmId;
  readonly laneIndex: number;
  /** World-meters anchor of the housing center. */
  readonly anchor: Vec2;
  /** Inbound unit heading (toward the box), world meters. */
  readonly inbound: Vec2;
  /** Right-of-inbound unit vector, world meters. */
  readonly right: Vec2;
  /** Movement index of the lane's left designation (arrow lamp), if served. */
  readonly leftMovementIndex: number | null;
  /** Movement index for through/right (ball lamp), if served. */
  readonly ballMovementIndex: number | null;
}

function toPx(points: readonly Vec2[]): Vec2[] {
  return points.map(worldToCanvas);
}

export class WorldRenderer {
  readonly geometry: IntersectionGeometry;
  readonly config: IntersectionConfig;
  private readonly stopControl: boolean;
  private readonly yieldLeftOfMovement: readonly boolean[];
  private readonly staticCommands: DrawCommand[];
  private readonly laneHeads: readonly LaneHeadLayout[];
  private readonly stopSignAnchors: readonly { anchor: Vec2; right: Vec2; inbound: Vec2 }[];

  constructor(geometry: IntersectionGeometry, config: IntersectionConfig) {
    this.geometry = geometry;
    this.config = config;
    this.stopControl = config.control.type === 'all-way-stop';
    this.yieldLeftOfMovement = geometry.movements.map((movement) => {
      if (movement.turn !== 'left') return false;
      if (config.control.type === 'all-way-stop') return true;
      return config.control.plan.leftMode[axisOfArm(movement.arm)] === 'permissive';
    });
    this.laneHeads = this.stopControl ? [] : this.buildLaneHeads();
    this.stopSignAnchors = this.stopControl ? this.buildStopSignAnchors() : [];
    this.staticCommands = this.buildStaticCommands();
  }

  // --- scene ----------------------------------------------------------------

  /** Read the world + control state into a plain scene (poses at `alpha`). */
  buildScene(world: CarWorld, control: ControlSystem, alpha: number, hud: SceneHud | null = null): RenderScene {
    const store = world.store;
    const cars: SceneCar[] = [];
    for (let i = 0; i < store.count; i += 1) {
      const entityId = i32At(store.entityId, i);
      const pathIndex = i32At(store.pathIndex, i);
      const length = f64At(store.carLengthMeters, i);
      const speed = f64At(store.speed, i);
      const pose = world.carPose(i, alpha);
      const half = length / 2;
      cars.push({
        entityId,
        x: pose.x - pose.hx * half,
        y: pose.y - pose.hy * half,
        hx: pose.hx,
        hy: pose.hy,
        lengthMeters: length,
        speedMps: speed,
        behavior: classifyCarBehavior({
          phase: control.claims.recordOf(entityId)?.phase,
          speedMps: speed,
          prevSpeedMps: f64At(store.prevSpeed, i),
          stopControl: this.stopControl,
          isYieldLeft: itemAt(this.yieldLeftOfMovement, pathIndex),
        }),
      });
    }
    const indications =
      control.signal !== null
        ? this.geometry.movements.map((_movement, m) => control.signal?.indication(m, world.tick) ?? 'red')
        : null;
    return {
      timeSeconds: world.time,
      tick: world.tick,
      controlType: this.stopControl ? 'all-way-stop' : 'signal',
      cars,
      indications,
      hud,
    };
  }

  /** Convenience: scene + frame in one call. */
  frame(world: CarWorld, control: ControlSystem, alpha: number, hud: SceneHud | null = null): DrawList {
    return this.buildFrame(this.buildScene(world, control, alpha, hud));
  }

  // --- frame assembly ---------------------------------------------------------

  buildFrame(scene: RenderScene): DrawList {
    const commands: DrawCommand[] = [...this.staticCommands];
    if (this.stopControl) {
      this.pushStopSigns(commands);
    } else {
      this.pushSignalHeads(commands, scene);
    }
    this.pushCars(commands, scene);
    this.pushHud(commands, scene);
    return commands;
  }

  private buildStaticCommands(): DrawCommand[] {
    const commands: DrawCommand[] = [];
    const markings = buildMarkings(this.geometry);

    commands.push({
      kind: 'fillPolygon',
      layer: 'background',
      points: [
        { x: 0, y: 0 },
        { x: 1280, y: 0 },
        { x: 1280, y: 720 },
        { x: 0, y: 720 },
      ],
      color: BACKGROUND_COLOR,
    });

    for (const poly of markings.roadPolygons) {
      commands.push({ kind: 'fillPolygon', layer: 'road', points: toPx(poly), color: ASPHALT_COLOR });
    }
    for (const line of markings.edgeLines) {
      commands.push({
        kind: 'strokePolyline',
        layer: 'markings',
        points: toPx(line),
        color: EDGE_LINE_COLOR,
        widthPx: EDGE_LINE_PX,
      });
    }
    for (const line of markings.centerLines) {
      commands.push({
        kind: 'strokePolyline',
        layer: 'markings',
        points: toPx(line),
        color: CENTER_LINE_COLOR,
        widthPx: CENTER_LINE_PX,
      });
    }
    for (const dash of markings.laneDividers) {
      commands.push({
        kind: 'strokePolyline',
        layer: 'markings',
        points: toPx(dash),
        color: LANE_DIVIDER_COLOR,
        widthPx: LANE_DIVIDER_PX,
      });
    }
    for (const bar of markings.stopBars) {
      commands.push({
        kind: 'strokePolyline',
        layer: 'markings',
        points: toPx(bar),
        color: EDGE_LINE_COLOR,
        widthPx: STOP_BAR_PX,
      });
    }
    this.pushLaneArrows(commands);
    return commands;
  }

  private pushLaneArrows(commands: DrawCommand[]): void {
    const layout = this.geometry.layout;
    for (const armId of ARM_IDS) {
      const arm = layout.arms[armId];
      const lanes = this.config.arms[armId].lanes;
      for (let laneIndex = 0; laneIndex < arm.laneCount; laneIndex += 1) {
        const designations: readonly TurnDirection[] = itemAt(lanes, laneIndex).designations;
        const glyph = laneArrowGlyph(designations);
        const stopCenter = itemAt(arm.approachLaneCentersAtStopLine, laneIndex);
        const origin = vadd(stopCenter, vscale(arm.inboundHeading, -ARROW_TAIL_BEFORE_STOP_METERS));
        const world = arrowGlyphToWorld(glyph, origin, arm.inboundHeading, arm.rightOfInbound);
        for (const stroke of world.strokes) {
          commands.push({
            kind: 'strokePolyline',
            layer: 'markings',
            points: toPx(stroke),
            color: ARROW_COLOR,
            widthPx: ARROW_STROKE_PX,
          });
        }
        for (const head of world.heads) {
          commands.push({ kind: 'fillPolygon', layer: 'markings', points: toPx(head), color: ARROW_COLOR });
        }
      }
    }
  }

  private pushSignalHeads(commands: DrawCommand[], scene: RenderScene): void {
    const indications = scene.indications;
    if (indications === null) return;
    for (const head of this.laneHeads) {
      const bays: { color: SignalColor; arrow: boolean }[] = [];
      if (head.leftMovementIndex !== null) {
        bays.push({ color: itemAt(indications, head.leftMovementIndex), arrow: true });
      }
      if (head.ballMovementIndex !== null) {
        bays.push({ color: itemAt(indications, head.ballMovementIndex), arrow: false });
      }
      if (bays.length === 0) continue;

      const anchorPx = worldToCanvas(head.anchor);
      const lengthPx = bays.length * HEAD_BAY_SPACING_PX + 2 * HEAD_BAY_PAD_PX;
      const halfLen = lengthPx / 2;
      const u = head.inbound;
      const r = head.right;
      // Housing corners (axis-aligned arms → axis-aligned rectangle).
      const corner = (a: number, b: number): Vec2 => ({
        x: anchorPx.x + u.x * a + r.x * b,
        y: anchorPx.y + u.y * a + r.y * b,
      });
      commands.push({
        kind: 'fillPolygon',
        layer: 'control',
        points: [
          corner(-halfLen, -HEAD_WIDTH_PX / 2),
          corner(-halfLen, HEAD_WIDTH_PX / 2),
          corner(halfLen, HEAD_WIDTH_PX / 2),
          corner(halfLen, -HEAD_WIDTH_PX / 2),
        ],
        color: SIGNAL_HOUSING_COLOR,
        strokeColor: SIGNAL_HOUSING_STROKE,
        strokePx: HEAD_HOUSING_STROKE_PX,
      });
      // Bays from the stop-line side inward: arrow lamp nearest the line.
      for (let k = 0; k < bays.length; k += 1) {
        const bay = bays[k];
        if (bay === undefined) continue;
        const along = halfLen - HEAD_BAY_PAD_PX - k * HEAD_BAY_SPACING_PX;
        const center = {
          x: anchorPx.x + u.x * along + r.x * 0,
          y: anchorPx.y + u.y * along + r.y * 0,
        };
        const color = SIGNAL_LAMP_COLORS[bay.color];
        if (bay.arrow) {
          // Left-pointing triangle lamp (left of the approaching driver).
          commands.push({
            kind: 'fillPolygon',
            layer: 'control',
            points: [
              { x: center.x - r.x * HEAD_ARROW_TIP_PX, y: center.y - r.y * HEAD_ARROW_TIP_PX },
              {
                x: center.x + r.x * HEAD_ARROW_BASE_PX + u.x * HEAD_ARROW_TIP_PX * 0.7,
                y: center.y + r.y * HEAD_ARROW_BASE_PX + u.y * HEAD_ARROW_TIP_PX * 0.7,
              },
              {
                x: center.x + r.x * HEAD_ARROW_BASE_PX - u.x * HEAD_ARROW_TIP_PX * 0.7,
                y: center.y + r.y * HEAD_ARROW_BASE_PX - u.y * HEAD_ARROW_TIP_PX * 0.7,
              },
            ],
            color,
          });
        } else {
          commands.push({
            kind: 'fillCircle',
            layer: 'control',
            x: center.x,
            y: center.y,
            radiusPx: HEAD_BALL_RADIUS_PX,
            color,
          });
        }
      }
    }
  }

  private pushStopSigns(commands: DrawCommand[]): void {
    for (const sign of this.stopSignAnchors) {
      const c = worldToCanvas(sign.anchor);
      const points: Vec2[] = [];
      for (let k = 0; k < 8; k += 1) {
        const a = (k * Math.PI) / 4 + Math.PI / 8;
        points.push({ x: c.x + Math.cos(a) * STOP_SIGN_RADIUS_PX, y: c.y + Math.sin(a) * STOP_SIGN_RADIUS_PX });
      }
      commands.push({
        kind: 'fillPolygon',
        layer: 'control',
        points,
        color: STOP_SIGN_FILL,
        strokeColor: STOP_SIGN_STROKE,
        strokePx: STOP_SIGN_STROKE_PX,
      });
      // Stylized text bar (D1: kept as a bar — real "STOP" text inside a
      // ~6 px octagon is illegible at this scale; the octagon + border is
      // the recognizable glyph).
      const u = sign.inbound;
      const r = sign.right;
      const barHalf = 2.7;
      commands.push({
        kind: 'fillPolygon',
        layer: 'control',
        points: [
          { x: c.x - r.x * barHalf - u.x * 0.5, y: c.y - r.y * barHalf - u.y * 0.5 },
          { x: c.x + r.x * barHalf - u.x * 0.5, y: c.y + r.y * barHalf - u.y * 0.5 },
          { x: c.x + r.x * barHalf + u.x * 0.5, y: c.y + r.y * barHalf + u.y * 0.5 },
          { x: c.x - r.x * barHalf + u.x * 0.5, y: c.y - r.y * barHalf + u.y * 0.5 },
        ],
        color: STOP_SIGN_STROKE,
      });
    }
  }

  private pushCars(commands: DrawCommand[], scene: RenderScene): void {
    for (const car of scene.cars) {
      const center = worldToCanvas({ x: car.x, y: car.y });
      commands.push({
        kind: 'fillRotRoundRect',
        layer: 'cars',
        x: center.x,
        y: center.y,
        angle: Math.atan2(car.hy, car.hx),
        lengthPx: car.lengthMeters * PX_PER_METER,
        widthPx: CAR_WIDTH_METERS * PX_PER_METER,
        radiusPx: (CAR_WIDTH_METERS / 2) * 0.6 * PX_PER_METER,
        color: CAR_BEHAVIOR_COLORS[car.behavior],
        strokeColor: CAR_STROKE_COLOR,
        strokePx: 1,
      });
    }
  }

  private pushHud(commands: DrawCommand[], scene: RenderScene): void {
    const hud = scene.hud;
    if (hud !== null) {
      const fpsColor = hud.fps >= 55 ? HUD_GOOD_COLOR : hud.fps >= 30 ? HUD_OK_COLOR : HUD_BAD_COLOR;
      commands.push({
        kind: 'text',
        layer: 'hud',
        x: 12,
        y: 12,
        text: `FPS ${hud.fps.toFixed(0)} (${hud.frameMs.toFixed(1)} ms/frame)`,
        color: fpsColor,
        fontPx: HUD_FONT_PX,
      });
    }
    commands.push({
      kind: 'text',
      layer: 'hud',
      x: 12,
      y: 32,
      text: `sim ${scene.timeSeconds.toFixed(1)} s · tick ${String(scene.tick)} · cars ${String(scene.cars.length)} · ${scene.controlType}`,
      color: HUD_TEXT_COLOR,
      fontPx: HUD_FONT_PX,
    });
  }

  // --- static layout of control devices --------------------------------------

  private buildLaneHeads(): LaneHeadLayout[] {
    const layout = this.geometry.layout;
    const heads: LaneHeadLayout[] = [];
    for (const armId of ARM_IDS) {
      const arm = layout.arms[armId];
      const lateral = arm.laneCount * layout.laneWidthMeters + HEAD_LATERAL_METERS;
      for (let laneIndex = 0; laneIndex < arm.laneCount; laneIndex += 1) {
        let leftMovementIndex: number | null = null;
        let ballMovementIndex: number | null = null;
        for (let m = 0; m < this.geometry.movements.length; m += 1) {
          const movement = itemAt(this.geometry.movements, m);
          if (movement.arm !== armId || movement.laneIndex !== laneIndex) continue;
          if (movement.turn === 'left') {
            if (leftMovementIndex === null) leftMovementIndex = m;
          } else if (ballMovementIndex === null) {
            ballMovementIndex = m;
          }
        }
        // Rightmost lane's head nearest the stop line; others stagger upstream.
        const stagger = (arm.laneCount - 1 - laneIndex) * HEAD_STAGGER_METERS;
        const outbound = vscale(arm.inboundHeading, -1);
        const anchor = vadd(
          vscale(outbound, arm.stopLineDistance + HEAD_LONGITUDINAL_METERS + stagger),
          vscale(arm.rightOfInbound, lateral),
        );
        heads.push({
          arm: armId,
          laneIndex,
          anchor,
          inbound: arm.inboundHeading,
          right: arm.rightOfInbound,
          leftMovementIndex,
          ballMovementIndex,
        });
      }
    }
    return heads;
  }

  private buildStopSignAnchors(): { anchor: Vec2; right: Vec2; inbound: Vec2 }[] {
    const layout = this.geometry.layout;
    const anchors: { anchor: Vec2; right: Vec2; inbound: Vec2 }[] = [];
    for (const armId of ARM_IDS) {
      const arm = layout.arms[armId];
      const lateral = arm.laneCount * layout.laneWidthMeters + HEAD_LATERAL_METERS;
      const outbound = vscale(arm.inboundHeading, -1);
      anchors.push({
        anchor: vadd(vscale(outbound, arm.stopLineDistance + 0.6), vscale(arm.rightOfInbound, lateral)),
        right: arm.rightOfInbound,
        inbound: arm.inboundHeading,
      });
    }
    return anchors;
  }
}
