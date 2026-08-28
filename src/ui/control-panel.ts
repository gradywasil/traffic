/**
 * DOM control panel (task U2): the real-DOM rendering of the PanelModel.
 *
 * Accessibility stance (town-hall §MVP.9): every control is a native DOM
 * input — buttons, selects, sliders (range), checkboxes — each with an
 * associated <label>, inside <fieldset>/<legend> groups; the panel is fully
 * keyboard-operable with visible focus states (stylesheet in index.html).
 * The canvas itself stays role="img" (not screen-reader-navigable); canvas
 * CLICKING selects arms/lanes, but the same editors are always reachable
 * from this panel.
 *
 * Wiring discipline: this class owns NO state — it renders the PanelModel
 * and forwards input events to model actions. The model validates and emits
 * (config-change / pause / speed / select); the app applies. Structural DOM
 * (lane rows, phase sliders) rebuilds only when the structure signature
 * changes (lane designations / phase kinds / control type) so a slider drag
 * never rebuilds the element being dragged.
 */
import {
  ARM_IDS,
  MAX_LANES_PER_ARM,
  MAX_SPAWN_RATE_VEH_PER_HOUR,
  MIN_GREEN_SECONDS,
  MIN_LANES_PER_ARM,
  TURN_DIRECTIONS,
} from '../config';
import type { ArmId, SignalPhaseKind, TurnDirection } from '../config';
import { PRESETS } from '../presets';
import { PLAYBACK_SPEEDS } from './playback';
import type { PlaybackSpeed } from './playback';
import type { PanelEvent, PanelModel } from './panel-model';

const ARM_LABELS: Readonly<Record<ArmId, string>> = {
  north: 'North',
  east: 'East',
  south: 'South',
  west: 'West',
};

const TURN_LABELS: Readonly<Record<TurnDirection, string>> = {
  left: 'Left',
  through: 'Through',
  right: 'Right',
};

const PHASE_LABELS: Readonly<Record<SignalPhaseKind, string>> = {
  'ns-protected-left': 'NS left (protected)',
  'ns-through-right': 'NS through / right',
  'ew-protected-left': 'EW left (protected)',
  'ew-through-right': 'EW through / right',
};

/** Upper slider bound for a phase green (cycle ≤ 180 s keeps 4×80 invalid — flagged, not clamped). */
const GREEN_SLIDER_MAX_SECONDS = 80;

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

interface SliderRefs {
  readonly row: HTMLElement;
  readonly input: HTMLInputElement;
  readonly output: HTMLOutputElement;
}

interface LaneRowRefs {
  readonly row: HTMLElement;
  readonly boxes: Readonly<Record<TurnDirection, HTMLInputElement>>;
}

interface ArmRefs {
  /** The collapsible arm section (details/summary — layout pass). */
  readonly section: HTMLDetailsElement;
  readonly spawn: SliderRefs;
  readonly mix: Readonly<Record<TurnDirection, SliderRefs>>;
  readonly laneCount: HTMLSelectElement;
  readonly laneRows: readonly LaneRowRefs[];
}

interface PlanRefs {
  readonly section: HTMLElement;
  readonly greens: readonly SliderRefs[];
  readonly cycleOut: HTMLOutputElement;
}

export class ControlPanel {
  private readonly model: PanelModel;
  private readonly root: HTMLElement;
  private readonly restRoot: HTMLElement;

  private readonly pauseButton: HTMLButtonElement;
  private readonly speedSelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly controlTypeSelect: HTMLSelectElement;
  private readonly planSection: HTMLFieldSetElement;
  private readonly armsSection: HTMLFieldSetElement;
  private readonly issuesList: HTMLUListElement;

  private armRefs = new Map<ArmId, ArmRefs>();
  private planRefs: PlanRefs | null = null;
  private structureCache = '';
  private idCounter = 0;
  private lastSelectionArm: ArmId | null = null;
  private lastSelectionLane: number | null = null;
  /** Last (arm, lane) reveal; repeats are calm (no scroll/focus steal). */
  private lastRevealKey = '';
  /** Arms opened programmatically (their toggle must not re-select). */
  private readonly programmaticOpens = new Set<ArmId>();

  constructor(container: HTMLElement, restContainer: HTMLElement, model: PanelModel) {
    this.model = model;
    container.textContent = '';
    restContainer.textContent = '';
    this.root = container;
    this.restRoot = restContainer;

    // --- playback -----------------------------------------------------------
    // (No panel-level title: the aside's aria-label and the group legends
    // carry the structure — the panel IS controls, a heading would restate
    // the obvious. Distill pass.)
    const playback = h('fieldset', 'playback-group');
    playback.append(h('legend', undefined, 'Playback'));
    this.pauseButton = h('button', 'pause-button', 'Pause');
    this.pauseButton.type = 'button';
    this.pauseButton.id = this.nextId('pause');
    this.pauseButton.addEventListener('click', () => this.model.togglePaused());
    this.speedSelect = h('select');
    this.speedSelect.id = this.nextId('speed');
    for (const speed of PLAYBACK_SPEEDS) {
      const option = h('option', undefined, `${String(speed)}×`);
      option.value = String(speed);
      this.speedSelect.append(option);
    }
    this.speedSelect.value = '1';
    this.speedSelect.addEventListener('change', () => {
      const parsed = Number.parseFloat(this.speedSelect.value);
      if (PLAYBACK_SPEEDS.includes(parsed as PlaybackSpeed)) {
        this.model.setSpeed(parsed as PlaybackSpeed);
      }
    });
    const speedLabel = h('label');
    speedLabel.htmlFor = this.speedSelect.id;
    speedLabel.textContent = 'Speed';
    const speedWrap = h('div', 'inline-field');
    speedWrap.append(speedLabel, this.speedSelect);
    playback.append(this.pauseButton, speedWrap);
    this.root.append(playback);

    // Task order (layout pass): the signal plan — the premise's named action —
    // mounts directly under transport, above the optimizer that grades it.
    this.planSection = h('fieldset', 'plan-group');
    this.root.append(this.planSection);

    // --- preset --------------------------------------------------------------
    const preset = h('fieldset', 'preset-group');
    preset.append(h('legend', undefined, 'Scenario preset'));
    this.presetSelect = h('select');
    this.presetSelect.id = this.nextId('preset');
    const customOption = h('option', undefined, 'Custom (edited)');
    customOption.value = 'custom';
    this.presetSelect.append(customOption);
    for (const candidate of PRESETS) {
      const option = h('option', undefined, candidate.name);
      option.value = candidate.id;
      this.presetSelect.append(option);
    }
    this.presetSelect.addEventListener('change', () => {
      const value = this.presetSelect.value;
      if (value === 'light' || value === 'balanced' || value === 'gridlock-risk') {
        this.model.applyPreset(value);
      }
    });
    // The legend names the group; the label stays associated but hidden —
    // "Scenario preset" + "Preset" said the same thing twice.
    const presetLabel = h('label', 'visually-hidden');
    presetLabel.htmlFor = this.presetSelect.id;
    presetLabel.textContent = 'Preset';
    preset.append(presetLabel, this.presetSelect);

    // --- control type ----------------------------------------------------------
    const control = h('fieldset', 'control-group');
    control.append(h('legend', undefined, 'Intersection control'));
    this.controlTypeSelect = h('select');
    this.controlTypeSelect.id = this.nextId('control-type');
    const signalOption = h('option', undefined, 'Signal (fixed-time plan)');
    signalOption.value = 'signal';
    const stopOption = h('option', undefined, 'All-way stop');
    stopOption.value = 'all-way-stop';
    this.controlTypeSelect.append(signalOption, stopOption);
    this.controlTypeSelect.addEventListener('change', () => {
      const value = this.controlTypeSelect.value;
      if (value === 'signal' || value === 'all-way-stop') this.model.setControlType(value);
    });
    const controlLabel = h('label', 'visually-hidden');
    controlLabel.htmlFor = this.controlTypeSelect.id;
    controlLabel.textContent = 'Control type';
    control.append(controlLabel, this.controlTypeSelect);

    // --- arms (below the optimizer mount — deep config, collapsed by default) --
    this.armsSection = h('fieldset', 'arms-group');
    this.armsSection.append(h('legend', undefined, 'Arms (approaches)'));
    const hint = h('p', 'hint', 'Tip: click an arm or lane on the canvas to open and edit it here.');
    this.armsSection.append(hint);

    // --- validation issues -----------------------------------------------------
    const issues = h('div', 'issues-group');
    this.issuesList = h('ul', 'issues-list');
    this.issuesList.id = this.nextId('issues');
    this.issuesList.setAttribute('role', 'alert');
    issues.append(h('h3', undefined, 'Invalid edit — not applied'), this.issuesList);

    this.restRoot.append(this.armsSection, control, preset, issues);

    this.rebuildArms();
    this.rebuildPlan();
    this.sync();

    this.model.subscribe((event) => this.onModelEvent(event));
  }

  // --- model events -----------------------------------------------------------

  private onModelEvent(event: PanelEvent): void {
    this.sync();
    if (event.type === 'select' && event.arm !== null) {
      this.revealSelection(event.arm, event.laneIndex);
    }
  }

  private revealSelection(arm: ArmId, laneIndex: number | null): void {
    const refs = this.armRefs.get(arm);
    if (refs === undefined) return;
    // Repeats stay calm: re-selecting what is already revealed neither
    // reopens (a user may be closing it) nor steals focus/scroll again.
    const key = `${arm}:${laneIndex === null ? 'null' : String(laneIndex)}`;
    if (refs.section.open && this.lastRevealKey === key) return;
    this.lastRevealKey = key;
    if (!refs.section.open) {
      // The toggle event must not re-select (it was programmatic).
      this.programmaticOpens.add(arm);
      refs.section.open = true;
    }
    refs.section.scrollIntoView({ block: 'nearest' });
    const focusTarget =
      laneIndex !== null && refs.laneRows[laneIndex] !== undefined
        ? refs.laneRows[laneIndex]?.boxes.through
        : refs.spawn.input;
    focusTarget?.focus();
  }

  // --- sync (values + structure) ------------------------------------------------

  private sync(): void {
    const draft = this.model.draft;

    // Playback + top selects.
    this.pauseButton.textContent = this.model.paused ? 'Play' : 'Pause';
    this.pauseButton.setAttribute('aria-pressed', this.model.paused ? 'true' : 'false');
    this.speedSelect.value = String(this.model.speed);
    this.presetSelect.value = this.model.presetId;
    this.controlTypeSelect.value = draft.control.type;

    // Structural rebuild when lane/plan structure changed.
    const signature = this.structureSignature();
    if (signature !== this.structureCache) {
      // A designation edit rebuilds the lane rows the user is INSIDE —
      // capture the focused checkbox and restore focus to its successor,
      // so keyboard interaction survives the rebuild (polish pass).
      const focusKey = this.focusedLaneCheckboxKey();
      this.structureCache = signature;
      this.rebuildArms();
      this.rebuildPlan();
      this.refocusLaneCheckbox(focusKey);
    }

    // Values.
    for (const arm of ARM_IDS) {
      const refs = this.armRefs.get(arm);
      const armConfig = draft.arms[arm];
      if (refs === undefined) continue;
      refs.spawn.input.value = String(armConfig.spawnRateVehPerHour);
      refs.spawn.output.textContent = `${String(armConfig.spawnRateVehPerHour)} veh/h`;
      for (const turn of TURN_DIRECTIONS) {
        const slider = refs.mix[turn];
        const percent = Math.round(armConfig.turnMix[turn] * 100);
        slider.input.value = String(percent);
        slider.output.textContent = `${String(percent)}%`;
      }
      refs.laneCount.value = String(armConfig.lanes.length);
      for (const [index, laneRow] of refs.laneRows.entries()) {
        const lane = armConfig.lanes[index];
        if (lane === undefined) continue;
        for (const turn of TURN_DIRECTIONS) {
          laneRow.boxes[turn].checked = lane.designations.includes(turn);
        }
      }
    }
    if (this.planRefs !== null && draft.control.type === 'signal') {
      const plan = draft.control.plan;
      this.planRefs.greens.forEach((slider, index) => {
        const phase = plan.phases[index];
        if (phase === undefined) return;
        slider.input.value = String(phase.greenSeconds);
        slider.output.textContent = `${String(phase.greenSeconds)} s`;
      });
      this.planRefs.cycleOut.textContent = `${String(plan.cycleLengthSeconds)} s`;
    }
    this.planSection.hidden = draft.control.type !== 'signal';

    // Issues.
    const issues = this.model.issues;
    this.issuesList.replaceChildren(
      ...issues.map((issue) => {
        const item = h('li', undefined, `${issue.path}: ${issue.message}`);
        return item;
      }),
    );
    const issuesGroup = this.issuesList.closest('.issues-group');
    if (issuesGroup !== null) issuesGroup.classList.toggle('has-issues', issues.length > 0);

    // Selection classes.
    const selection = this.model.selection;
    if (selection.arm !== this.lastSelectionArm || selection.laneIndex !== this.lastSelectionLane) {
      this.lastSelectionArm = selection.arm;
      this.lastSelectionLane = selection.laneIndex;
      for (const arm of ARM_IDS) {
        const refs = this.armRefs.get(arm);
        if (refs === undefined) continue;
        refs.section.classList.toggle('selected', selection.arm === arm);
        refs.laneRows.forEach((laneRow, index) => {
          laneRow.row.classList.toggle('selected', selection.arm === arm && selection.laneIndex === index);
        });
      }
    }
  }

  /** (arm, laneIndex, boxIndex) of the focused lane checkbox, or null. */
  private focusedLaneCheckboxKey(): { arm: ArmId; laneIndex: number; boxIndex: number } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || active.type !== 'checkbox') return null;
    const section = active.closest('.arm-section');
    const row = active.closest('.lane-row');
    if (section === null || row === null) return null;
    const arm = section.getAttribute('data-arm');
    if (arm !== 'north' && arm !== 'east' && arm !== 'south' && arm !== 'west') return null;
    const laneIndex = [...section.querySelectorAll('.lane-row')].indexOf(row);
    const boxIndex = [...row.querySelectorAll("input[type='checkbox']")].indexOf(active);
    if (laneIndex < 0 || boxIndex < 0) return null;
    return { arm, laneIndex, boxIndex };
  }

  /** Focus the successor of the pre-rebuild checkbox `key` identified (if any). */
  private refocusLaneCheckbox(key: { arm: ArmId; laneIndex: number; boxIndex: number } | null): void {
    if (key === null) return;
    const turn = TURN_DIRECTIONS[key.boxIndex];
    if (turn === undefined) return;
    const refs = this.armRefs.get(key.arm);
    const row = refs?.laneRows[key.laneIndex];
    if (row === undefined) return; // the edit removed this lane row
    row.boxes[turn]?.focus();
  }

  private structureSignature(): string {    const draft = this.model.draft;
    const phases = draft.control.type === 'signal' ? draft.control.plan.phases.map((phase) => phase.kind) : [];
    return JSON.stringify({
      control: draft.control.type,
      phases,
      lanes: ARM_IDS.map((arm) => draft.arms[arm].lanes.map((lane) => lane.designations.join('+'))),
    });
  }

  // --- builders ------------------------------------------------------------------

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `u2-${prefix}-${String(this.idCounter)}`;
  }

  private makeSlider(
    labelText: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (value: number) => void,
    valuePrefix = '',
  ): SliderRefs {
    const row = h('div', 'slider-field');
    const input = h('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.id = this.nextId('slider');
    input.addEventListener('input', () => {
      onInput(Number.parseFloat(input.value));
    });
    const label = h('label');
    label.htmlFor = input.id;
    const output = h('output');
    output.textContent = `${valuePrefix}${String(value)}`;
    label.append(`${labelText} `, output);
    row.append(label, input);
    return { row, input, output };
  }

  private rebuildArms(): void {
    const draft = this.model.draft;
    // A designation edit rebuilds the rows the user is inside — carry the
    // open state across, or the editor collapses mid-edit (polish pass).
    const openByArm = new Map<string, boolean>();
    for (const section of this.armsSection.querySelectorAll<HTMLDetailsElement>('details.arm-section')) {
      openByArm.set(section.getAttribute('data-arm') ?? '', section.open);
    }
    this.armRefs.clear();
    const sections: HTMLDetailsElement[] = [];
    for (const arm of ARM_IDS) {
      const armConfig = draft.arms[arm];
      // Collapsed by default (layout pass): the summary selects the arm,
      // canvas selection opens the editor. Native details/summary keeps it
      // keyboard-operable and exposes expanded state to AT.
      const section = h('details', 'arm-section') as HTMLDetailsElement;
      section.dataset.arm = arm;
      if (openByArm.get(arm) === true) section.open = true;
      section.addEventListener('toggle', () => {
        if (this.programmaticOpens.delete(arm)) return;
        if (section.open) this.model.select(arm);
      });

      const summary = h('summary', 'arm-summary');
      summary.append(h('h3', undefined, `${ARM_LABELS[arm]} arm`));
      section.append(summary);

      const spawn = this.makeSlider(
        'Spawn rate',
        0,
        MAX_SPAWN_RATE_VEH_PER_HOUR,
        10,
        armConfig.spawnRateVehPerHour,
        (value) => this.model.setSpawnRate(arm, value),
        ' veh/h',
      );
      section.append(spawn.row);

      const mixGroup = h('div', 'mix-group');
      mixGroup.append(h('h4', undefined, 'Turn mix'));
      const mix = {} as Record<TurnDirection, SliderRefs>;
      for (const turn of TURN_DIRECTIONS) {
        const slider = this.makeSlider(
          TURN_LABELS[turn],
          0,
          100,
          1,
          Math.round(armConfig.turnMix[turn] * 100),
          (value) => this.model.setTurnMixPart(arm, turn, value / 100),
          '%',
        );
        mix[turn] = slider;
        mixGroup.append(slider.row);
      }
      section.append(mixGroup);

      const laneField = h('div', 'inline-field');
      const laneCount = h('select');
      laneCount.id = this.nextId('lane-count');
      for (let count = MIN_LANES_PER_ARM; count <= MAX_LANES_PER_ARM; count += 1) {
        const option = h('option', undefined, `${String(count)} ${count === 1 ? 'lane' : 'lanes'}`);
        option.value = String(count);
        laneCount.append(option);
      }
      laneCount.value = String(armConfig.lanes.length);
      laneCount.addEventListener('change', () => {
        this.model.setLaneCount(arm, Number.parseInt(laneCount.value, 10));
      });
      const laneLabel = h('label');
      laneLabel.htmlFor = laneCount.id;
      laneLabel.textContent = 'Lane count';
      laneField.append(laneLabel, laneCount);
      section.append(laneField);

      const lanesGroup = h('div', 'lanes-group');
      const laneRows: LaneRowRefs[] = [];
      armConfig.lanes.forEach((lane, laneIndex) => {
        const row = h('div', 'lane-row');
        const name = h('span', 'lane-name', `Lane ${String(laneIndex + 1)}${laneIndex === 0 ? ' (left)' : ''}`);
        row.append(name);
        const boxes = {} as Record<TurnDirection, HTMLInputElement>;
        for (const turn of TURN_DIRECTIONS) {
          const box = h('input');
          box.type = 'checkbox';
          box.id = this.nextId(`lane-${arm}-${String(laneIndex)}-${turn}`);
          box.checked = lane.designations.includes(turn);
          box.addEventListener('change', () => {
            const designations = TURN_DIRECTIONS.filter((candidate) => boxes[candidate].checked);
            this.model.setDesignations(arm, laneIndex, designations);
          });
          boxes[turn] = box;
          const boxLabel = h('label', 'lane-turn-label');
          boxLabel.htmlFor = box.id;
          boxLabel.textContent = TURN_LABELS[turn];
          row.append(box, boxLabel);
        }
        laneRows.push({ row, boxes });
        lanesGroup.append(row);
      });
      section.append(lanesGroup);

      this.armRefs.set(arm, {
        section,
        spawn,
        mix,
        laneCount,
        laneRows,
      });
      sections.push(section);
    }
    // Keep the tip line first, then the arm sections.
    const tip = this.armsSection.querySelector('.hint');
    this.armsSection.replaceChildren();
    if (tip !== null) this.armsSection.append(tip);
    this.armsSection.append(...sections);
  }

  private rebuildPlan(): void {
    const draft = this.model.draft;
    this.planRefs = null;
    this.planSection.replaceChildren();
    if (draft.control.type !== 'signal') return;
    this.planSection.append(h('legend', undefined, 'Signal plan (per-phase green)'));

    const plan = draft.control.plan;
    const greens: SliderRefs[] = [];
    plan.phases.forEach((phase, index) => {
      const slider = this.makeSlider(
        PHASE_LABELS[phase.kind],
        MIN_GREEN_SECONDS,
        GREEN_SLIDER_MAX_SECONDS,
        1,
        phase.greenSeconds,
        (value) => this.model.setGreenSeconds(index, value),
        ' s',
      );
      greens.push(slider);
      this.planSection.append(slider.row);
    });

    const cycleLine = h('p', 'cycle-line');
    const cycleOut = h('output');
    cycleOut.textContent = `${String(plan.cycleLengthSeconds)} s`;
    cycleLine.append('Cycle length (auto-fit): ', cycleOut);
    const note = h(
      'p',
      'hint',
      'Yellow and all-red intervals are computed from the intersection geometry and are not editable.',
    );
    this.planSection.append(cycleLine, note);
    this.planRefs = { section: this.planSection, greens, cycleOut };
  }
}
