/**
 * Playback binding tests (task U2 acceptance): pause + speed are wired to
 * the loop with the correct SIM-TIME behavior — the update stream is a pure
 * function of the frame timestamps, the speed multiplier and the pause
 * state; never of wall-clock reads inside the simulation.
 */
import { describe, expect, it } from 'vitest';
import type { FixedTimestepLoop } from '../loop';
import { PLAYBACK_SPEEDS, PlaybackController } from './playback';
import type { PlaybackSpeed } from './playback';

interface Harness {
  updateDts: number[];
  renders: Array<{ alpha: number; frameDt: number }>;
  controller: PlaybackController;
  frame: (timestampMs: number) => ReturnType<FixedTimestepLoop['frame']>;
}

function makePlayback(fixedDt = 0.1): Harness {
  const updateDts: number[] = [];
  const renders: Array<{ alpha: number; frameDt: number }> = [];
  const controller = new PlaybackController({
    fixedDt,
    update: (dt) => updateDts.push(dt),
    render: (alpha, frameDt) => renders.push({ alpha, frameDt }),
  });
  return { updateDts, renders, controller, frame: (ts) => controller.frame(ts) };
}

/** Feed frames every `stepMs`; return total updates fired. */
function runFrames(h: Harness, count: number, stepMs: number, startMs = 0): number {
  let updates = 0;
  for (let index = 0; index < count; index += 1) {
    updates += h.frame(startMs + index * stepMs).updates;
  }
  return updates;
}

describe('PlaybackController — speed multiplier (sim-time behavior)', () => {
  it('first frame establishes the clock with no update', () => {
    const h = makePlayback();
    expect(h.frame(0).updates).toBe(0);
    expect(h.updateDts).toHaveLength(0);
  });

  it.each([...PLAYBACK_SPEEDS])('%sx speed advances sim time at exactly that wall-rate multiple', (speed) => {
    const h = makePlayback();
    h.controller.setSpeed(speed as PlaybackSpeed);
    h.frame(0);
    // 10 frames x 100 ms = 1000 ms wall -> 1000 x speed ms virtual.
    const updates = runFrames(h, 10, 100, 100);
    expect(updates).toBe(Math.round(10 * speed));
    // Every update is exactly one fixed step, never a scaled delta.
    for (const dt of h.updateDts) expect(dt).toBe(0.1);
  });

  it('0.5x: updates arrive every other 100 ms frame (accumulator carries)', () => {
    const h = makePlayback();
    h.controller.setSpeed(0.5);
    h.frame(0);
    const pattern: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      pattern.push(h.frame(100 + index * 100).updates);
    }
    // 50 ms virtual per frame: 0,1,0,1,0,1 updates.
    expect(pattern).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('speed change mid-run applies to subsequent frames only (no virtual-time jump)', () => {
    const h = makePlayback();
    h.frame(0);
    h.frame(100); // 1x: one update
    h.controller.setSpeed(4);
    const updates = runFrames(h, 3, 100, 200); // 3 frames x 400 ms virtual
    expect(updates).toBe(12);
    expect(h.updateDts.every((dt) => dt === 0.1)).toBe(true);
  });

  it('render receives the REAL wall frame delta, not the scaled one', () => {
    const h = makePlayback();
    h.controller.setSpeed(2);
    h.frame(0);
    h.frame(50);
    const render = h.renders[h.renders.length - 1];
    expect(render?.frameDt).toBeCloseTo(0.05, 10); // 50 ms wall, not 100 ms
  });
});

describe('PlaybackController — pause', () => {
  it('paused frames fire zero updates but keep rendering', () => {
    const h = makePlayback();
    h.frame(0);
    h.controller.setPaused(true);
    for (let index = 0; index < 10; index += 1) {
      expect(h.frame(100 + index * 100).updates).toBe(0);
    }
    expect(h.updateDts).toHaveLength(0);
    expect(h.renders.length).toBe(11); // every frame still rendered
  });

  it('unpausing resumes without a catch-up burst', () => {
    const h = makePlayback();
    h.frame(0);
    h.controller.setPaused(true);
    // Simulate a long pause: many frames while paused.
    for (let index = 0; index < 50; index += 1) h.frame(100 + index * 100);
    h.controller.setPaused(false);
    const afterUnpause = h.frame(5100);
    // Steady-state 1x frame: exactly one update, not the whole paused span.
    expect(afterUnpause.updates).toBe(1);
    expect(h.updateDts).toHaveLength(1);
  });

  it('alpha holds still while paused (frozen interpolation)', () => {
    const h = makePlayback();
    h.frame(0);
    h.frame(50); // 50 ms banked, alpha 0.5
    h.controller.setPaused(true);
    const before = h.renders[h.renders.length - 1]?.alpha;
    h.frame(100);
    h.frame(150);
    expect(h.renders[h.renders.length - 1]?.alpha).toBe(before);
  });
});

describe('PlaybackController — robustness parity with F1', () => {
  it('a giant frame gap is clamped and cannot flood the sim even at 4x', () => {
    const h = makePlayback();
    h.controller.setSpeed(4);
    h.frame(0);
    // 10 s gap -> clamped to 0.25 s wall -> 1.0 s virtual -> 10 updates max.
    const result = h.frame(10_000);
    expect(result.updates).toBe(10);
    expect(result.droppedDt).toBe(0);
  });

  it('non-monotonic clock reads produce zero-length frames', () => {
    const h = makePlayback();
    h.frame(1000);
    expect(h.frame(900).updates).toBe(0);
  });

  it('setSpeed rejects values outside the committed set', () => {
    const h = makePlayback();
    expect(() => h.controller.setSpeed(3 as never)).toThrow(/speed/);
    expect(h.controller.speed).toBe(1);
  });
});
