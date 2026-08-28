/**
 * Engineering overlay panel (task U3): the DOM half of the thin engineering
 * overlay (town-hall §MVP.5). Read-mostly by design: one native checkbox
 * toggles it (labeled, keyboard-operable — the accessibility stance); every
 * value renders as real DOM text driven by the pure `buildOverlayModel`
 * (snapshot values verbatim), with per-arm control-delay bars as plain DIV
 * rectangles — DOM rects, so each bar sits inside a labeled text row and
 * adds no second canvas to manage (research R3's "plain rects"; D1-friendly).
 *
 * Update cadence: the same ~1 Hz sim-time gate as the chart (`SimTimeGate`);
 * while hidden the model is still cached, so toggling on renders instantly
 * from the last snapshot. The toggle state lives in the checkbox and nothing
 * ever rebuilds this panel — "persists in-session" by construction.
 *
 * Structure is FIXED (4 arms; fixed summary/param row counts), so `render()`
 * only assigns textContent and bar widths — no DOM churn at 1 Hz.
 */
import { ARM_IDS } from '../../config';
import type { ArmId, IntersectionConfig } from '../../config';
import type { MetricsSnapshot } from '../../sim/metrics/types';
import { SimTimeGate } from '../chart/gate';
import { buildOverlayModel } from './overlay';
import type { OverlayLabelValue, OverlayModel } from './overlay';

const ARM_LABELS: Readonly<Record<ArmId, string>> = {
  north: 'North',
  east: 'East',
  south: 'South',
  west: 'West',
};

/** Spillback honesty note (R1 §6.1) carried next to the queue columns. */
export const OVERLAY_SPILLBACK_NOTE =
  'During full-arm spillback, zone delay saturates while queues keep growing — read the queue columns, not just the delay bars.';

/** Row counts of the fixed overlay structure (must match the builders). */
const SUMMARY_ROW_COUNT = 10;
const PARAM_ROW_COUNT = 14;

interface ArmElements {
  readonly barFill: HTMLElement;
  readonly delayValue: HTMLElement;
  readonly stopped: HTMLElement;
  readonly throughput: HTMLElement;
  readonly queue: HTMLElement;
  readonly queuePerLane: HTMLElement;
}

function textNode(initial: string): HTMLElement {
  const node = document.createElement('span');
  node.textContent = initial;
  return node;
}

/** A <dt><dd></dd></dt>-style pair appended to a <dl>; returns the dd. */
function appendDescriptionRow(list: HTMLElement, label: string): { label: HTMLElement; value: HTMLElement } {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = '—';
  list.append(dt, dd);
  return { label: dt, value: dd };
}

export class EngineeringOverlay {
  private readonly gate = new SimTimeGate(1);
  private model: OverlayModel | null = null;
  private visibleState = false;

  private readonly body: HTMLElement;
  private readonly summaryRows: readonly { label: HTMLElement; value: HTMLElement }[];
  private readonly armElements: Readonly<Record<ArmId, ArmElements>>;
  private readonly paramRows: readonly { label: HTMLElement; value: HTMLElement }[];

  constructor(container: HTMLElement) {
    container.textContent = '';

    // --- toggle (real DOM control, labeled) ----------------------------------
    const toggleRow = document.createElement('div');
    toggleRow.className = 'overlay-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'engineering-overlay-toggle';
    toggle.addEventListener('change', () => {
      this.visibleState = toggle.checked;
      this.body.hidden = !this.visibleState;
      if (this.visibleState) this.render();
    });
    const toggleLabel = document.createElement('label');
    toggleLabel.htmlFor = toggle.id;
    toggleLabel.textContent = 'Engineering overlay';
    toggleRow.append(toggle, toggleLabel);
    container.append(toggleRow);

    // --- body (hidden until toggled on) ---------------------------------------
    this.body = document.createElement('div');
    this.body.className = 'overlay-body';
    this.body.hidden = true;

    // Window statistics.
    const summaryHeading = document.createElement('h3');
    summaryHeading.textContent = 'Window statistics';
    const summaryList = document.createElement('dl');
    summaryList.className = 'overlay-summary';
    this.summaryRows = Array.from({ length: SUMMARY_ROW_COUNT }, () =>
      appendDescriptionRow(summaryList, '—'),
    );
    this.body.append(summaryHeading, summaryList);

    // Per-arm delay bars.
    const barsHeading = document.createElement('h3');
    barsHeading.textContent = 'Per-arm control delay (window mean)';
    const bars = document.createElement('div');
    bars.className = 'arm-bars';
    const barFills = {} as Record<ArmId, { fill: HTMLElement; value: HTMLElement }>;
    for (const arm of ARM_IDS) {
      const row = document.createElement('div');
      row.className = 'arm-bar-row';
      const name = document.createElement('span');
      name.className = 'arm-bar-name';
      name.textContent = ARM_LABELS[arm];
      const track = document.createElement('div');
      track.className = 'arm-bar-track';
      const fill = document.createElement('div');
      fill.className = 'arm-bar-fill';
      track.append(fill);
      const value = textNode('—');
      value.className = 'arm-bar-value';
      row.append(name, track, value);
      bars.append(row);
      barFills[arm] = { fill, value };
    }
    this.body.append(barsHeading, bars);

    // Per-arm detail table.
    const detailHeading = document.createElement('h3');
    detailHeading.textContent = 'Per-arm detail';
    const table = document.createElement('table');
    table.className = 'overlay-arm-table';
    const headRow = document.createElement('tr');
    for (const heading of ['Arm', 'Stopped (mean)', 'Throughput', 'Max queue', 'Max queue / lane']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = heading;
      headRow.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    const detailCells = {} as Record<ArmId, { stopped: HTMLElement; throughput: HTMLElement; queue: HTMLElement; queuePerLane: HTMLElement }>;
    for (const arm of ARM_IDS) {
      const row = document.createElement('tr');
      const armHead = document.createElement('th');
      armHead.scope = 'row';
      armHead.textContent = ARM_LABELS[arm];
      row.append(armHead);
      const cells: HTMLElement[] = [];
      for (let i = 0; i < 4; i += 1) {
        const cell = document.createElement('td');
        cell.textContent = '—';
        row.append(cell);
        cells.push(cell);
      }
      tbody.append(row);
      const [stopped, throughput, queue, queuePerLane] = cells as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
      detailCells[arm] = { stopped, throughput, queue, queuePerLane };
    }
    table.append(thead, tbody);
    this.body.append(detailHeading, table);

    // Model-parameter read-out (config ModelParams + dt + lane width).
    const paramsHeading = document.createElement('h3');
    paramsHeading.textContent = 'Model parameters (read-only)';
    const paramsList = document.createElement('dl');
    paramsList.className = 'overlay-params';
    this.paramRows = Array.from({ length: PARAM_ROW_COUNT }, () => appendDescriptionRow(paramsList, '—'));
    this.body.append(paramsHeading, paramsList);

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = OVERLAY_SPILLBACK_NOTE;
    this.body.append(note);

    const armElements = {} as Record<ArmId, ArmElements>;
    for (const arm of ARM_IDS) {
      armElements[arm] = {
        barFill: barFills[arm].fill,
        delayValue: barFills[arm].value,
        stopped: detailCells[arm].stopped,
        throughput: detailCells[arm].throughput,
        queue: detailCells[arm].queue,
        queuePerLane: detailCells[arm].queuePerLane,
      };
    }
    this.armElements = armElements;
    container.append(this.body);
  }

  /** Per-frame hook: gate on sim time; refresh the cached model at ~1 Hz. */
  frame(snapshot: MetricsSnapshot, config: IntersectionConfig): void {
    if (!this.gate.crossed(snapshot.timeSeconds)) return;
    this.model = buildOverlayModel(snapshot, config);
    if (this.visibleState) this.render();
  }

  get visible(): boolean {
    return this.visibleState;
  }

  /** Assign cached-model values into the fixed DOM (textContent + bar widths). */
  private render(): void {
    const model = this.model;
    if (model === null) return;
    this.assignRows(this.summaryRows, model.summary);
    for (const arm of ARM_IDS) {
      const elements = this.armElements[arm];
      const row = model.arms.find((candidate) => candidate.arm === arm);
      if (row === undefined) continue;
      elements.barFill.style.width = `${(row.barFraction * 100).toFixed(1)}%`;
      elements.delayValue.textContent = row.delayText;
      elements.stopped.textContent = row.stoppedText;
      elements.throughput.textContent = row.throughputText;
      elements.queue.textContent = row.queueText;
      elements.queuePerLane.textContent = row.queuePerLaneText;
    }
    this.assignRows(this.paramRows, model.params);
  }

  private assignRows(
    targets: readonly { label: HTMLElement; value: HTMLElement }[],
    rows: readonly OverlayLabelValue[],
  ): void {
    rows.forEach((row, index) => {
      const target = targets[index];
      if (target === undefined) return;
      target.label.textContent = row.label;
      target.value.textContent = row.value;
    });
  }
}
