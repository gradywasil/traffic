import { describe, expect, it } from 'vitest';
import { FixedTimestepLoop } from './loop';
import type { LoopOptions } from './loop';

interface Harness {
  updateDts: number[];
  renders: Array<{ alpha: number; frameDt: number }>;
  frame: (timestampMs: number) => ReturnType<FixedTimestepLoop['frame']>;
}

function makeLoop(fixedDt: number, maxUpdatesPerFrame?: number): Harness {
  const updateDts: number[] = [];
  const renders: Array<{ alpha: number; frameDt: number }> = [];
  const options: LoopOptions = {
    fixedDt,
    update: (dt) => updateDts.push(dt),
    render: (alpha, frameDt) => renders.push({ alpha, frameDt }),
  };
  if (maxUpdatesPerFrame !== undefined) options.maxUpdatesPerFrame = maxUpdatesPerFrame;
  const loop = new FixedTimestepLoop(options);
  return { updateDts, renders, frame: (ts) => loop.frame(ts) };
}

describe('FixedTimestepLoop accumulator (committed fixedDt = 0.1 s = 100 ms)', () => {
  it('first frame establishes the clock: one render at alpha 0, no update', () => {
    const h = makeLoop(0.1);
    const result = h.frame(0);
    expect(result).toEqual({ updates: 0, alpha: 0, frameDt: 0, droppedDt: 0 });
    expect(h.updateDts).toHaveLength(0);
    expect(h.renders).toEqual([{ alpha: 0, frameDt: 0 }]);
  });

  it('sub-fimestep 32 ms gaps accumulate without updating, with exact interpolation alpha', () => {
    const h = makeLoop(0.1);
    h.frame(0);
    // Three 32 ms gaps: 32, 64, 96 ms banked — still no update due.
    expect(h.frame(32)).toMatchObject({ updates: 0, alpha: 0.32 });
    expect(h.frame(64)).toMatchObject({ updates: 0, alpha: 0.64 });
    expect(h.frame(96)).toMatchObject({ updates: 0, alpha: 0.96 });
    expect(h.updateDts).toHaveLength(0);
    // Fourth 32 ms gap crosses 100 ms: exactly one update, 28 ms remainder.
    expect(h.frame(128)).toMatchObject({ updates: 1, alpha: 0.28 });
    expect(h.updateDts).toHaveLength(1);
  });

  it('sustained 32 ms gaps produce exactly 2 updates across the sequence (accumulator carry)', () => {
    const h = makeLoop(0.1);
    let updates = 0;
    for (let ts = 0; ts <= 224; ts += 32) {
      updates += h.frame(ts).updates;
    }
    // 224 ms of frames banked 224 ms ≥ 2 × 100 ms but < 3 × 100 ms.
    expect(updates).toBe(2);
    expect(h.updateDts).toEqual([0.1, 0.1]);
  });

  it('two 125 ms frames each fire one update: 2 updates total, sim time tracks wall time', () => {
    const h = makeLoop(0.1);
    h.frame(0);
    expect(h.frame(125)).toMatchObject({ updates: 1, alpha: 0.25 });
    expect(h.frame(250)).toMatchObject({ updates: 1, alpha: 0.5 });
    expect(h.updateDts).toEqual([0.1, 0.1]);
  });

  it('a single 250 ms gap fires 2 updates in one frame, rendering the 0.5 interpolation', () => {
    const h = makeLoop(0.1);
    h.frame(0);
    const result = h.frame(250);
    expect(result.updates).toBe(2);
    expect(result.alpha).toBeCloseTo(0.5, 10);
    expect(result.frameDt).toBeCloseTo(0.25, 10);
    expect(result.droppedDt).toBe(0);
  });

  it('always hands the update hook exactly the fixed dt, never the frame delta', () => {
    const h = makeLoop(0.1);
    h.frame(0);
    h.frame(33);
    h.frame(183); // one update (33 + 183 = 216 ms banked)
    h.frame(400); // 217 ms more → 2 updates
    for (const dt of h.updateDts) expect(dt).toBe(0.1);
    expect(h.updateDts.length).toBeGreaterThanOrEqual(3);
  });

  it('clamps huge frame gaps to maxFrameDt (tab stall cannot flood the sim)', () => {
    const h = makeLoop(0.1); // default maxFrameDt = 0.25 s
    h.frame(0);
    const result = h.frame(10_000); // 10 s stall
    expect(result.frameDt).toBeCloseTo(0.25, 10);
    expect(result.updates).toBe(2); // 250 ms clamped → exactly two 100 ms steps
    expect(result.droppedDt).toBe(0);
  });

  it('drops backlog beyond the per-frame update cap instead of death-spiraling', () => {
    const updateDts: number[] = [];
    const loop = new FixedTimestepLoop({
      fixedDt: 0.1,
      maxFrameDt: 1.0, // honor a full 1 s frame...
      maxUpdatesPerFrame: 3, // ...but never run more than 3 updates per frame
      update: (dt) => updateDts.push(dt),
      render: () => {},
    });
    loop.frame(0);
    const result = loop.frame(1_000); // 1 s gap, only 3 × 100 ms consumed
    expect(result.updates).toBe(3);
    expect(result.droppedDt).toBeCloseTo(0.7, 10);
    expect(result.alpha).toBe(0);
    expect(updateDts).toEqual([0.1, 0.1, 0.1]);
    // The next frame starts from a clean slate (backlog shed, not carried).
    expect(loop.frame(1_032)).toMatchObject({ updates: 0, alpha: 0.32 });
  });

  it('treats non-monotonic timestamps as zero-length frames (no update, no rollback)', () => {
    const h = makeLoop(0.1);
    h.frame(500);
    const result = h.frame(400);
    expect(result).toMatchObject({ updates: 0, alpha: 0, frameDt: 0 });
    // Clock resynced to 400; the next 100 ms is a legitimate update.
    expect(h.frame(500)).toMatchObject({ updates: 1, alpha: 0 });
  });

  it('rejects invalid construction', () => {
    expect(() => new FixedTimestepLoop({ fixedDt: 0, update: () => {}, render: () => {} })).toThrow();
    expect(() => new FixedTimestepLoop({ fixedDt: -1, update: () => {}, render: () => {} })).toThrow();
    expect(
      () =>
        new FixedTimestepLoop({ fixedDt: 0.1, maxUpdatesPerFrame: 0, update: () => {}, render: () => {} }),
    ).toThrow();
  });
});
