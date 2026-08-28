/**
 * Canvas picking tests (task U2): the click → (arm, lane) mapping used by
 * the canvas interaction — logical↔world px transforms and approach-lane
 * hit-testing on the F3 layout (balanced preset geometry).
 */
import { describe, expect, it } from 'vitest';
import { ARM_IDS } from '../config';
import { buildIntersectionGeometry } from '../geom';
import { CANVAS_CENTER_PX, ROAD_FILL_WIDTH_ZOOM, worldToCanvas } from '../geom';
import { getPreset } from '../presets';
import { clientPointToLogicalPx, logicalPxToWorldMeters, pickArmLane } from './picking';

const geometry = buildIntersectionGeometry(getPreset('balanced').config);

describe('coordinate transforms', () => {
  it('logicalPxToWorldMeters is the exact inverse of worldToCanvas', () => {
    for (const world of [
      { x: 0, y: 0 },
      { x: -110, y: 42.5 },
      { x: 63.25, y: -97.75 },
    ]) {
      const logical = worldToCanvas(world);
      const roundTrip = logicalPxToWorldMeters(logical);
      expect(roundTrip.x).toBeCloseTo(world.x, 9);
      expect(roundTrip.y).toBeCloseTo(world.y, 9);
    }
  });

  it('clientPointToLogicalPx scales CSS coordinates into the 1280x720 frame', () => {
    const rect = { left: 0, top: 0, width: 940, height: 528.75 };
    // The logical center maps to the CSS center.
    const center = clientPointToLogicalPx(rect, 470, 264.375);
    expect(center.x).toBeCloseTo(CANVAS_CENTER_PX.x, 6);
    expect(center.y).toBeCloseTo(CANVAS_CENTER_PX.y, 6);
    // Full CSS width spans the full logical width.
    const corner = clientPointToLogicalPx(rect, 940, 528.75);
    expect(corner.x).toBeCloseTo(1280, 6);
    expect(corner.y).toBeCloseTo(720, 6);
  });

  it('clientPointToLogicalPx inverts the mobile view zoom about the center', () => {
    const rect = { left: 0, top: 0, width: 378, height: 212.625 };
    const zoom = ROAD_FILL_WIDTH_ZOOM;
    // The center is zoom-invariant.
    const center = clientPointToLogicalPx(rect, 189, 106.3125, zoom);
    expect(center.x).toBeCloseTo(CANVAS_CENTER_PX.x, 6);
    expect(center.y).toBeCloseTo(CANVAS_CENTER_PX.y, 6);
    // A CSS left-edge tap maps back to the world's left edge: the road runs
    // edge to edge under the zoom, so the screen edge IS the arm end.
    const leftEdge = clientPointToLogicalPx(rect, 0, 106.3125, zoom);
    expect(leftEdge.x).toBeCloseTo(CANVAS_CENTER_PX.x - CANVAS_CENTER_PX.x / zoom, 6);
    // Round trip: a world point, painted under the zoom, taps back to itself.
    const world = { x: -80, y: 12 };
    const logical = worldToCanvas(world);
    const onScreen = {
      x: ((CANVAS_CENTER_PX.x + (logical.x - CANVAS_CENTER_PX.x) * zoom) / 1280) * rect.width,
      y: ((CANVAS_CENTER_PX.y + (logical.y - CANVAS_CENTER_PX.y) * zoom) / 720) * rect.height,
    };
    const picked = clientPointToLogicalPx(rect, onScreen.x, onScreen.y, zoom);
    expect(picked.x).toBeCloseTo(logical.x, 6);
    expect(picked.y).toBeCloseTo(logical.y, 6);
  });
});

describe('pickArmLane — approach-lane hit testing', () => {
  it('clicking a lane near the stop line selects that (arm, lane)', () => {
    for (const arm of ARM_IDS) {
      const layoutArm = geometry.layout.arms[arm];
      layoutArm.approachLaneCentersAtStopLine.forEach((center, laneIndex) => {
        // A point a few meters upstream of the stop line, mid-lane.
        const upstream = {
          x: center.x - layoutArm.inboundHeading.x * 5,
          y: center.y - layoutArm.inboundHeading.y * 5,
        };
        expect(pickArmLane(geometry, upstream)).toEqual({ arm, laneIndex });
      });
    }
  });

  it('clicking mid-approach also selects', () => {
    const north = geometry.layout.arms.north;
    const mid = {
      x: north.approachLaneCentersAtStopLine[0]!.x - north.inboundHeading.x * 40,
      y: north.approachLaneCentersAtStopLine[0]!.y - north.inboundHeading.y * 40,
    };
    expect(pickArmLane(geometry, mid)).toEqual({ arm: 'north', laneIndex: 0 });
  });

  it('the intersection box, exit lanes and off-road deselect', () => {
    expect(pickArmLane(geometry, { x: 0, y: 0 })).toBeNull(); // box center
    // Exit side of the north arm (outbound traffic side of the same road):
    const north = geometry.layout.arms.north;
    const exitPoint = {
      x: north.exitLaneCentersAtBoundary[0]!.x - north.outboundHeading.x * 10,
      y: north.exitLaneCentersAtBoundary[0]!.y - north.outboundHeading.y * 10,
    };
    expect(pickArmLane(geometry, exitPoint)).toBeNull();
    expect(pickArmLane(geometry, { x: 119, y: 119 })).toBeNull(); // off-road corner
  });
});
