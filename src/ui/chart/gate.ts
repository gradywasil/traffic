/**
 * Sim-time sample gate (task U3): the "~1 Hz" chart cadence, keyed to SIM
 * time, not wall clock (research R3: "1 Hz render cadence outside the sim
 * frame loop"). A sample is taken only when sim time crosses a multiple of
 * the sample interval — the chart's state can therefore only advance at
 * window boundaries, and:
 *
 * - at 1× speed the chart redraws at 1 Hz wall-clock;
 * - at 0.5–4× speed it redraws at 0.5–4 Hz (still trivial, ≤ 4 draws/s);
 * - paused sim time never crosses a boundary → no redraws while paused;
 * - a non-monotonic jump (world reset) is itself a boundary crossing.
 *
 * Deterministic and wall-clock-free: no Date/performance.now anywhere.
 */
export class SimTimeGate {
  private lastTimeSeconds: number | null = null;

  constructor(private readonly intervalSeconds: number) {
    if (!(intervalSeconds > 0) || !Number.isFinite(intervalSeconds)) {
      throw new Error(`gate interval must be finite > 0 s, got ${String(intervalSeconds)}`);
    }
  }

  /**
   * Observe a sim time; true when it crossed an interval boundary since the
   * last call (or on the first call, so an initial frame draws immediately).
   */
  crossed(timeSeconds: number): boolean {
    const didCross =
      this.lastTimeSeconds === null ||
      Math.floor(timeSeconds / this.intervalSeconds) !== Math.floor(this.lastTimeSeconds / this.intervalSeconds);
    this.lastTimeSeconds = timeSeconds;
    return didCross;
  }

  /** Forget the last observation (next call crosses again). */
  reset(): void {
    this.lastTimeSeconds = null;
  }

  get lastTime(): number | null {
    return this.lastTimeSeconds;
  }
}
