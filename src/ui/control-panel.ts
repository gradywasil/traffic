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
  readonly section: HTMLElement;
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

  constructor(container: HTMLElement, model: PanelModel) {
    this.model = model;
    container.textContent = '';
    this.root = container;

    const heading = h('h2', undefined, 'Intersection controls');
    this.root.append(heading);

    // --- playback -----------------------------------------------------------
    const playback = h('fieldset', 'playback-group');
    playback.append(h('legend', undefined, 'Playback'));
    this.pauseButton = h('button', 'pause-button', 'Pause');
    this.pauseButton.type = 'button';
    this.pauseButton.id = this.nextId('pause');
    const pauseLabel = h('label');
    pauseLabel.htmlFor = this.pauseButton.id;
    pauseLabel.textContent = 'Simulation';
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
    playback.append(pauseLabel, this.pauseButton, speedWrap);
    this.root.append(playback);

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
    const presetLabel = h('label');
    presetLabel.htmlFor = this.presetSelect.id;
    presetLabel.textContent = 'Preset';
    preset.append(presetLabel, this.presetSelect);
    this.root.append(preset);

    // --- control type + signal plan ------------------------------------------
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
    const controlLabel = h('label');
    controlLabel.htmlFor = this.controlTypeSelect.id;
    controlLabel.textContent = 'Control type';
    control.append(controlLabel, this.controlTypeSelect);
    this.root.append(control);

    this.planSection = h('fieldset', 'plan-group');
    this.root.append(this.planSection);

    // --- arms ----------------------------------------------------------------
    this.armsSection = h('fieldset', 'arms-group');
    this.armsSection.append(h('legend', undefined, 'Arms (approaches)'));
    const hint = h('p', 'hint', 'Tip: click an arm or lane on the canvas to select and edit it here.');
    this.armsSection.append(hint);
    this.root.append(this.armsSection);

    // --- validation issues -----------------------------------------------------
    const issues = h('div', 'issues-group');
    this.issuesList = h('ul', 'issues-list');
    this.issuesList.id = this.nextId('issues');
    this.issuesList.setAttribute('role', 'alert');
    issues.append(h('h3', undefined, 'Invalid edit — not applied'), this.issuesList);
    this.root.append(issues);

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
      this.structureCache = signature;
      this.rebuildArms();
      this.rebuildPlan();
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

  private structureSignature(): string {
    const draft = this.model.draft;
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
    this.armRefs.clear();
    const sections: HTMLElement[] = [];
    for (const arm of ARM_IDS) {
      const armConfig = draft.arms[arm];
      const section = h('section', 'arm-section');
      section.dataset.arm = arm;

      const heading = h('h3');
      const selectButton = h('button', 'arm-select-button', `${ARM_LABELS[arm]} arm`);
      selectButton.type = 'button';
      selectButton.addEventListener('click', () => this.model.select(arm));
      heading.append(selectButton);
      section.append(heading);

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
        const name = h('span', 'lane-name', `Lane ${String(laneIndex + 1)}${laneIndex === 0 ? ' (leftmost)' : ''}`);
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
      'Yellow and all-red intervals are computed from geometry (research R1 §5.1) and are not editable.',
    );
    this.planSection.append(cycleLine, note);
    this.planRefs = { section: this.planSection, greens, cycleOut };
  }
}
