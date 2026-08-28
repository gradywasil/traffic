/**
 * All-way stop controller tests (task F5): arm tables (right-of / oncoming
 * derived from geometry headings), ticket stamping discipline (first
 * stopped-at-line tick only), and the total departure-order comparator —
 * FIFO first, right tiebreak for simultaneous stops, arm order (N,E,S,W)
 * then lane as the deterministic fallback.
 */
import { describe, expect, it } from 'vitest';
import { ARM_IDS } from '../../config';
import { AllWayStopController, oppositeArmOf, rightArmOf } from './stop';
import type { StopTicket } from './stop';

describe('arm tables', () => {
  it('right-of matches the geometry headings (screen frame, y down)', () => {
    // North arm drivers head south (0,1) → their right is west; etc.
    expect(rightArmOf('north')).toBe('west');
    expect(rightArmOf('west')).toBe('south');
    expect(rightArmOf('south')).toBe('east');
    expect(rightArmOf('east')).toBe('north');
  });

  it('oncoming arms are the axis partners', () => {
    expect(oppositeArmOf('north')).toBe('south');
    expect(oppositeArmOf('south')).toBe('north');
    expect(oppositeArmOf('east')).toBe('west');
    expect(oppositeArmOf('west')).toBe('east');
  });
});

describe('ticket stamping', () => {
  it('stamps the first stopped-at-line tick and keeps it', () => {
    const stop = new AllWayStopController();
    const north = ARM_IDS.indexOf('north');
    stop.observe(10, 1, north, 0, false, true); // moving — no ticket
    expect(stop.size).toBe(0);
    stop.observe(11, 1, north, 0, true, false); // stopped but not at the line
    expect(stop.size).toBe(0);
    stop.observe(12, 1, north, 0, true, true);
    expect(stop.size).toBe(1);
    const ticket: StopTicket | undefined = stop.ticketOf(1);
    expect(ticket?.tick).toBe(12);
    stop.observe(13, 1, north, 0, true, true); // already stamped
    stop.observe(20, 1, north, 0, false, false); // later movement never re-stamps
    expect(stop.ticketOf(1)?.tick).toBe(12);
    expect(stop.hasTicket(1)).toBe(true);
    expect(stop.hasTicket(99)).toBe(false);
  });

  it('prunes departed cars', () => {
    const stop = new AllWayStopController();
    stop.observe(5, 1, 0, 0, true, true);
    stop.observe(5, 2, 1, 0, true, true);
    stop.prune(new Set([2]));
    expect(stop.size).toBe(1);
    expect(stop.hasTicket(1)).toBe(false);
  });
});

describe('departure-order comparator', () => {
  const north = ARM_IDS.indexOf('north');
  const east = ARM_IDS.indexOf('east');
  const south = ARM_IDS.indexOf('south');
  const west = ARM_IDS.indexOf('west');

  function stamped(tickOf: Map<number, number>): AllWayStopController {
    const stop = new AllWayStopController();
    for (const [entityId, tick] of tickOf) {
      const armIndex = entityId === 10 ? north : entityId === 20 ? east : entityId === 30 ? south : west;
      stop.observe(tick, entityId, armIndex, 0, true, true);
    }
    return stop;
  }

  it('FIFO: earlier stop ticks depart first', () => {
    const stop = stamped(
      new Map([
        [10, 100],
        [20, 130],
        [30, 160],
      ]),
    );
    expect(stop.compare(10, 20)).toBeLessThan(0);
    expect(stop.compare(20, 30)).toBeLessThan(0);
    expect(stop.compare(30, 10)).toBeGreaterThan(0);
  });

  it('simultaneous stops: the car on the right departs first (N yields W)', () => {
    const stop = stamped(
      new Map([
        [10, 50], // north
        [40, 50], // west — sits on north's right
      ]),
    );
    expect(stop.rightYieldCount(10)).toBe(1); // north has west on its right
    expect(stop.rightYieldCount(40)).toBe(0);
    expect(stop.compare(10, 40)).toBeGreaterThan(0); // west first
    expect(stop.compare(40, 10)).toBeLessThan(0);
  });

  it('simultaneous opposing stops: no right relation → arm order N,E,S,W', () => {
    const stop = stamped(
      new Map([
        [10, 50], // north
        [30, 50], // south (not on north's right; north not on south's right)
      ]),
    );
    expect(stop.rightYieldCount(10)).toBe(0);
    expect(stop.rightYieldCount(30)).toBe(0);
    expect(stop.compare(10, 30)).toBeLessThan(0); // N before S
  });

  it('simultaneous three-way stop: the lone un-yielded car wins, then arm order', () => {
    // N, W, S stop at the same tick: N has W on its right (yields), W has S
    // on its right (yields), S has nobody → S departs first, then arm order
    // among N and W (N first).
    const stop = stamped(
      new Map([
        [10, 70], // north
        [30, 70], // south
        [40, 70], // west
      ]),
    );
    expect(stop.rightYieldCount(30)).toBe(0);
    expect(stop.rightYieldCount(10)).toBe(1);
    expect(stop.rightYieldCount(40)).toBe(1);
    expect(stop.compare(30, 10)).toBeLessThan(0);
    expect(stop.compare(30, 40)).toBeLessThan(0);
    expect(stop.compare(10, 40)).toBeLessThan(0); // fallback arm order
  });

  it('unticketed cars sort last (defensive)', () => {
    const stop = stamped(new Map([[10, 5]]));
    expect(stop.compare(10, 999)).toBeLessThan(0);
    expect(stop.compare(999, 10)).toBeGreaterThan(0);
  });
});
