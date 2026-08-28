/**
 * Headline text-readout binding tests (task U3 acceptance): the text stats
 * update FROM SNAPSHOTS — `headlineTexts` is the pure binding (snapshot →
 * display strings) the DOM layer assigns verbatim, pinned here including the
 * no-trips ("—") and rounding behavior.
 *
 * (The DOM half of MetricsChart follows the control-panel convention: a thin
 * untested shell over pure, tested functions; the chart core it drives is
 * covered by chart-state/draw/scale tests.)
 */
import { describe, expect, it } from 'vitest';
import type { ArmId } from '../../config';
import type { ArmMetrics, MetricsSnapshot } from '../../sim/metrics/types';
import { headlineTexts } from './metrics-chart';

function snapshotFixture(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const emptyArm = (arm: ArmId): ArmMetrics => ({
    arm,
    tripCount: 0,
    meanControlDelaySeconds: null,
    meanStoppedSeconds: null,
    throughputVehPerHour: null,
    maxQueueCars: 0,
    maxQueuePerLane: [],
  });
  return {
    timeSeconds: 60,
    windowSeconds: 180,
    elapsedSinceResetSeconds: 60,
    tripCount: 40,
    meanControlDelaySeconds: 12.34,
    controlDelayP50Seconds: 9,
    controlDelayP85Seconds: 22,
    controlDelayP95Seconds: 30,
    meanStoppedSeconds: 5,
    throughputVehPerHour: 842.6,
    maxQueueCars: 7,
    currentQueuePerChain: new Array<number>(12).fill(0),
    arms: {
      north: emptyArm('north'),
      east: emptyArm('east'),
      south: emptyArm('south'),
      west: emptyArm('west'),
    },
    ...overrides,
  };
}

describe('headlineTexts — text readout binding', () => {
  it('renders avg wait + throughput from a live snapshot', () => {
    const texts = headlineTexts(snapshotFixture());
    expect(texts.avgWait).toBe('12.3 s');
    expect(texts.throughput).toBe('843 veh/h');
    expect(texts.detail).toBe('40 trips in window · max queue 7 · since reset 1:00');
  });

  it('before any completed trip: dashes, not zeros or NaN', () => {
    const texts = headlineTexts(
      snapshotFixture({
        tripCount: 0,
        meanControlDelaySeconds: null,
        throughputVehPerHour: null,
        maxQueueCars: 0,
        elapsedSinceResetSeconds: 0,
      }),
    );
    expect(texts.avgWait).toBe('—');
    expect(texts.throughput).toBe('—');
    expect(texts.detail).toBe('0 trips in window · max queue 0 · since reset 0:00');
  });

  it('rounds display to one decimal; throughput to whole veh/h', () => {
    const texts = headlineTexts(snapshotFixture({ meanControlDelaySeconds: 0.04, throughputVehPerHour: 0.4 }));
    expect(texts.avgWait).toBe('0 s');
    expect(texts.throughput).toBe('0 veh/h');
  });

  it('binds per-snapshot (values track the snapshot, not stale state)', () => {
    const first = headlineTexts(snapshotFixture());
    const second = headlineTexts(snapshotFixture({ meanControlDelaySeconds: 20, throughputVehPerHour: 500 }));
    expect(second.avgWait).not.toBe(first.avgWait);
    expect(second.throughput).not.toBe(first.throughput);
    expect(second.avgWait).toBe('20 s');
    expect(second.throughput).toBe('500 veh/h');
  });
});
