/**
 * Optimizer DOM panel (task O2): the real-DOM rendering of the OptimizerModel
 * — same wiring discipline as U2's ControlPanel (owns no state; renders the
 * model, forwards clicks to model actions).
 *
 * Accessibility stance: native buttons ("Optimize timings", per-row "Apply",
 * "Cancel"), a polite `role="status"` live region for progress/results, and
 * `role="alert"` for a blocked apply. All values render as text; the ranked
 * list is a scrollable container with every row present (the report is
 * bounded ≤ ~99 candidates by O1's `maxCandidates`).
 *
 * Update discipline (the "don't jank the live sim" half of O2): render()
 * assigns `disabled`/`textContent` on FIXED elements only, and rebuilds the
 * results list solely when a new report lands or the applied plan's greens
 * change (the "current" marker follows applies/edits). Progress renders
 * arrive already throttled by the model (default 150 ms).
 */
import type { OptimizerModel, OptimizerResultsView } from './optimizer-model';

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export class OptimizerPanel {
  private readonly model: OptimizerModel;
  private readonly runButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private readonly resultsContainer: HTMLDivElement;
  private readonly applyAlert: HTMLParagraphElement;
  private lastResultsSource: object | null = null;
  private lastCurrentKey = '';

  constructor(container: HTMLElement, model: OptimizerModel) {
    this.model = model;
    container.textContent = '';

    const group = h('fieldset', 'optimizer-group');
    group.append(h('legend', undefined, 'Signal timing optimizer'));
    group.append(
      h(
        'p',
        'hint',
        'Sweeps green splits with paired-seed deterministic runs and ranks plans by mean control delay vs the current plan.',
      ),
    );

    const buttons = h('div', 'optimizer-buttons');
    this.runButton = h('button', 'optimizer-run-button', 'Optimize timings');
    this.runButton.type = 'button';
    this.runButton.addEventListener('click', () => this.model.start());
    this.cancelButton = h('button', 'optimizer-cancel-button', 'Cancel');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.model.cancel());
    buttons.append(this.runButton, this.cancelButton);
    group.append(buttons);

    this.status = h('p', 'optimizer-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    group.append(this.status);

    this.resultsContainer = h('div', 'optimizer-results');
    this.resultsContainer.hidden = true;
    group.append(this.resultsContainer);

    this.applyAlert = h('p', 'optimizer-apply-issue');
    this.applyAlert.setAttribute('role', 'alert');
    this.applyAlert.hidden = true;
    group.append(this.applyAlert);

    container.append(group);

    model.subscribe(() => this.render());
    this.render();
  }

  // --- render ---------------------------------------------------------------

  private render(): void {
    const model = this.model;

    const blocked = model.startBlockedReason;
    this.runButton.disabled = model.isRunning || blocked !== null;
    this.runButton.title = blocked ?? '';
    this.cancelButton.disabled = !model.canCancel;
    this.status.textContent = this.statusText();

    const results = model.results;
    const source = model.outcome;
    const currentKey = model.appliedCandidateId ?? '';
    if (results === null) {
      this.resultsContainer.hidden = true;
      this.lastResultsSource = null;
      this.lastCurrentKey = '';
    } else if (source !== this.lastResultsSource || currentKey !== this.lastCurrentKey) {
      this.lastResultsSource = source;
      this.lastCurrentKey = currentKey;
      this.resultsContainer.hidden = false;
      this.renderResults(results);
    }

    const issues = model.applyIssues;
    this.applyAlert.hidden = issues === null;
    this.applyAlert.textContent =
      issues === null
        ? ''
        : `Plan not applied — ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`;
  }

  /** Compose the status line from model state (text only, no DOM reads). */
  private statusText(): string {
    const model = this.model;
    switch (model.phase) {
      case 'idle':
        return model.startBlockedReason ?? 'Ready to sweep the current signal plan.';
      case 'running': {
        const progress = model.progress;
        if (progress === null) return 'Running — preparing candidates…';
        return `Running — ${String(progress.completed)} / ${String(progress.total)} runs · ${formatElapsed(model.elapsedMs)}`;
      }
      case 'done': {
        const results = model.results;
        if (results === null) return 'Done.';
        const best = results.rows.find((row) => row.isBest) ?? null;
        const bestText = best !== null && best.delayMeanSeconds !== null ? best.delayText : 'unranked';
        const currentText = results.currentDelayText ?? 'no trips';
        return `Done in ${formatElapsed(results.elapsedMs)} — best ${bestText} vs current ${currentText} (${String(results.totalRuns)} runs, ${results.executorName}).`;
      }
      case 'cancelled': {
        const completed = model.cancelledAfterCompleted;
        const count = completed === null ? '' : ` after ${String(completed)} runs`;
        return `Cancelled${count} — partial results discarded (a sweep is only rankable complete).`;
      }
      case 'failed':
        return model.errorText === null ? 'Failed.' : `Failed — ${model.errorText}`;
    }
  }

  /** Rebuild the ranked list (only on a new report / moved current marker). */
  private renderResults(results: OptimizerResultsView): void {
    const container = this.resultsContainer;
    container.replaceChildren();

    const summary = h('p', 'optimizer-results-summary');
    const currentBits = [results.currentDelayText ?? 'no trips'];
    if (results.currentSpreadText !== null) currentBits.push(results.currentSpreadText);
    summary.append(
      `Current plan: ${currentBits.join(' ')} (${results.currentMeasuredLabel}). `,
      `Ranked candidates (${String(results.candidateCount)} plans · ${String(results.totalRuns)} runs · ${results.executorName} · ${formatElapsed(results.elapsedMs)}):`,
    );
    container.append(summary);

    const list = h('div', 'optimizer-rows');
    for (const row of results.rows) {
      const item = h('div', `optimizer-row${row.isBest ? ' best' : ''}${row.isCurrent ? ' current' : ''}`);

      const head = h('span', 'optimizer-row-head');
      const rank = h('span', 'optimizer-rank', `${String(row.rank)}.`);
      const greens = h('span', 'optimizer-greens', row.greensLabel);
      head.append(rank, greens);
      if (row.isBest) head.append(h('span', 'optimizer-badge badge-best', 'Best'));
      if (row.isCurrent) head.append(h('span', 'optimizer-badge badge-current', 'Current'));
      item.append(head);

      const metrics = h('span', 'optimizer-metrics', row.delayText);
      if (row.spreadText !== null) metrics.append(` ${row.spreadText}`);
      item.append(metrics);

      item.append(h('span', 'optimizer-delta', row.deltaText ?? (row.isCurrent ? '—' : '')));

      const apply = h('button', 'optimizer-apply-button', 'Apply');
      apply.type = 'button';
      apply.disabled = row.delayMeanSeconds === null;
      apply.setAttribute('aria-label', `Apply plan ${row.greensLabel} seconds of green`);
      apply.addEventListener('click', () => this.model.apply(row.rank));
      item.append(apply);

      list.append(item);
    }
    container.append(list);
  }
}
