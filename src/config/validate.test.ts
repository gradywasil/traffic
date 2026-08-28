import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from './defaults';
import type {
  ArmConfig,
  ArmId,
  AxisId,
  IntersectionConfig,
  LaneConfig,
  LeftMode,
  SignalPhaseConfig,
  SignalPlanConfig,
  TurnDirection,
  TurnMix,
} from './model';
import { formatValidationIssue, validateConfig } from './validate';
import type { ValidationIssue } from './validate';

const SHARED_MIX: TurnMix = { left: 0.25, through: 0.5, right: 0.25 };

function baseConfig(): IntersectionConfig {
  return createDefaultConfig();
}

function withArm(config: IntersectionConfig, armId: ArmId, arm: ArmConfig): IntersectionConfig {
  return { ...config, arms: { ...config.arms, [armId]: arm } };
}

function withAllArms(arm: ArmConfig): IntersectionConfig {
  let config = baseConfig();
  for (const armId of ['north', 'east', 'south', 'west'] as const satisfies readonly ArmId[]) {
    config = withArm(config, armId, arm);
  }
  return config;
}

function makeArm(
  lanes: readonly LaneConfig[],
  turnMix: TurnMix = SHARED_MIX,
  spawnRateVehPerHour = 300,
  cruiseSpeedMps = 13.9,
): ArmConfig {
  return { lanes, turnMix, spawnRateVehPerHour, cruiseSpeedMps };
}

function makePlan(
  phases: readonly SignalPhaseConfig[],
  cycleLengthSeconds = 60,
  leftMode: Readonly<Record<AxisId, LeftMode>> = { ns: 'permissive', ew: 'permissive' },
): SignalPlanConfig {
  return { cycleLengthSeconds, leftMode, phases };
}

function withPlan(plan: SignalPlanConfig): IntersectionConfig {
  return { ...baseConfig(), control: { type: 'signal', plan } };
}

function issuesOf(config: IntersectionConfig): readonly ValidationIssue[] {
  return validateConfig(config);
}

function messages(config: IntersectionConfig): string[] {
  return issuesOf(config).map(formatValidationIssue);
}

describe('validateConfig: valid baselines', () => {
  it('accepts the default config with zero issues', () => {
    expect(issuesOf(baseConfig())).toEqual([]);
  });

  it('accepts the all-way stop control variant', () => {
    const config: IntersectionConfig = { ...baseConfig(), control: { type: 'all-way-stop' } };
    expect(issuesOf(config)).toEqual([]);
  });
});

describe('validateConfig: lanes and designations', () => {
  it('rejects an arm with zero lanes', () => {
    const issues = issuesOf(withArm(baseConfig(), 'north', makeArm([])));
    expect(issues.find((issue) => issue.path === 'arms.north.lanes')?.message).toMatch(
      /between 1 and 3 lanes, got 0/,
    );
  });

  it('rejects an arm with four lanes (max is 3)', () => {
    const lanes: readonly LaneConfig[] = [
      { designations: ['left'] },
      { designations: ['through'] },
      { designations: ['through'] },
      { designations: ['right'] },
    ];
    const issues = issuesOf(withArm(baseConfig(), 'north', makeArm(lanes)));
    expect(issues.find((issue) => issue.path === 'arms.north.lanes')?.message).toMatch(/got 4/);
  });

  it('rejects empty designations', () => {
    const issues = issuesOf(withArm(baseConfig(), 'east', makeArm([{ designations: [] }])));
    expect(issues.find((issue) => issue.path === 'arms.east.lanes[0].designations')?.message).toMatch(
      /at least one/,
    );
  });

  it('rejects duplicate and unknown designations', () => {
    const dup = messages(withArm(baseConfig(), 'north', makeArm([{ designations: ['left', 'left'] }])));
    expect(dup.some((line) => /duplicate turn designation 'left'/.test(line))).toBe(true);

    const bogusLane: LaneConfig = {
      designations: ['u-turn' as unknown as TurnDirection],
    };
    const unknown = messages(withArm(baseConfig(), 'north', makeArm([bogusLane])));
    expect(unknown.some((line) => /unknown turn designation 'u-turn'/.test(line))).toBe(true);
  });

  it('rejects non-array lanes instead of throwing', () => {
    const arm: ArmConfig = {
      ...makeArm([{ designations: ['through'] }]),
      lanes: 'nope' as unknown as readonly LaneConfig[],
    };
    expect(issuesOf(withArm(baseConfig(), 'north', arm)).some((issue) => issue.path === 'arms.north.lanes')).toBe(true);
  });
});

describe('validateConfig: turn mix coherence', () => {
  it('rejects probability for a turn no lane on the arm serves', () => {
    const arm = makeArm([{ designations: ['through'] }], { left: 0.3, through: 0.5, right: 0.2 });
    const issues = issuesOf(withArm(baseConfig(), 'south', arm));
    expect(issues.find((issue) => issue.path === 'arms.south.turnMix.left')?.message).toMatch(
      /no lane serving 'left' on arm 'south'/,
    );
  });

  it('accepts zero probability for a designated turn (a lane may go unused)', () => {
    const arm = makeArm([{ designations: ['left', 'through', 'right'] }], {
      left: 0,
      through: 0.5,
      right: 0.5,
    });
    expect(issuesOf(withArm(baseConfig(), 'south', arm))).toEqual([]);
  });

  it('rejects mixes that do not sum to 1', () => {
    const arm = makeArm([{ designations: ['left', 'through', 'right'] }], {
      left: 0.2,
      through: 0.5,
      right: 0.2,
    });
    expect(
      issuesOf(withArm(baseConfig(), 'north', arm)).some(
        (issue) => issue.path === 'arms.north.turnMix' && /sum to 1/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects negative probabilities', () => {
    const arm = makeArm([{ designations: ['left', 'through', 'right'] }], {
      left: -0.1,
      through: 0.6,
      right: 0.5,
    });
    expect(
      issuesOf(withArm(baseConfig(), 'north', arm)).some(
        (issue) => issue.path === 'arms.north.turnMix.left',
      ),
    ).toBe(true);
  });
});

describe('validateConfig: numeric bounds', () => {
  it('rejects out-of-range spawn rates and cruise speeds', () => {
    const spawn = { ...baseConfig().arms.north, spawnRateVehPerHour: 3601 };
    expect(
      issuesOf(withArm(baseConfig(), 'north', spawn)).some(
        (issue) => issue.path === 'arms.north.spawnRateVehPerHour',
      ),
    ).toBe(true);

    const cruise = { ...baseConfig().arms.north, cruiseSpeedMps: 0 };
    expect(
      issuesOf(withArm(baseConfig(), 'north', cruise)).some(
        (issue) => issue.path === 'arms.north.cruiseSpeedMps',
      ),
    ).toBe(true);
  });

  it('allows a closed arm (spawn rate 0)', () => {
    const closed = { ...baseConfig().arms.north, spawnRateVehPerHour: 0 };
    expect(issuesOf(withArm(baseConfig(), 'north', closed))).toEqual([]);
  });

  it('rejects dt outside (0, 0.5] seconds', () => {
    expect(issuesOf({ ...baseConfig(), dt: 0 }).some((issue) => issue.path === 'dt')).toBe(true);
    expect(issuesOf({ ...baseConfig(), dt: 0.6 }).some((issue) => issue.path === 'dt')).toBe(true);
  });

  it('rejects degenerate geometry', () => {
    const config = { ...baseConfig(), geometry: { laneWidthMeters: 0 } };
    expect(
      issuesOf(config).some((issue) => issue.path === 'geometry.laneWidthMeters'),
    ).toBe(true);
  });

  it('rejects incoherent model params (b_e < b and s0 < s_min)', () => {
    const emergency = {
      ...baseConfig(),
      modelParams: { ...baseConfig().modelParams, emergencyDecelMps2: 1.5 },
    };
    expect(
      issuesOf(emergency).some((issue) => issue.path === 'modelParams.emergencyDecelMps2'),
    ).toBe(true);

    const queueGap = {
      ...baseConfig(),
      modelParams: { ...baseConfig().modelParams, minGapMeters: 0.2 },
    };
    expect(issuesOf(queueGap).some((issue) => issue.path === 'modelParams.minGapMeters')).toBe(true);
  });
});

describe('validateConfig: structural robustness', () => {
  it('reports (never throws on) a missing arm', () => {
    const config = baseConfig();
    const arms = { ...config.arms } as Partial<Record<ArmId, ArmConfig>>;
    delete arms.south;
    const issues = issuesOf({ ...config, arms: arms as IntersectionConfig['arms'] });
    expect(issues.some((issue) => issue.path === 'arms.south' && /missing/.test(issue.message))).toBe(
      true,
    );
  });

  it('reports on completely malformed config objects without throwing', () => {
    expect(issuesOf({} as IntersectionConfig).length).toBeGreaterThan(0);
    expect(issuesOf(null as unknown as IntersectionConfig)).toHaveLength(1);
  });
});

describe('validateConfig: control type', () => {
  it('rejects an unknown control type', () => {
    const control = { type: 'roundabout' } as unknown as IntersectionConfig['control'];
    expect(issuesOf({ ...baseConfig(), control }).some((issue) => issue.path === 'control.type')).toBe(
      true,
    );
  });

  it('rejects a signal control without a plan', () => {
    const control = { type: 'signal' } as unknown as IntersectionConfig['control'];
    expect(issuesOf({ ...baseConfig(), control }).some((issue) => issue.path === 'control.plan')).toBe(
      true,
    );
  });
});

describe('validateConfig: signal plan (R1 §5.1/§5.2)', () => {
  it('rejects greens below g_min = 5 s', () => {
    const plan = makePlan([
      { kind: 'ns-through-right', greenSeconds: 4 },
      { kind: 'ew-through-right', greenSeconds: 48 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some((issue) => issue.path === 'control.plan.phases[0].greenSeconds'),
    ).toBe(true);
  });

  it('rejects non-integer greens', () => {
    const plan = makePlan([
      { kind: 'ns-through-right', greenSeconds: 25.5 },
      { kind: 'ew-through-right', greenSeconds: 26.5 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) =>
          issue.path === 'control.plan.phases[0].greenSeconds' && /whole number/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects a ring missing a required phase', () => {
    const plan = makePlan([{ kind: 'ns-through-right', greenSeconds: 56 }]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) => issue.path === 'control.plan.phases' && /NEMA-lite/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects phases out of canonical ring order', () => {
    const plan = makePlan([
      { kind: 'ew-through-right', greenSeconds: 26 },
      { kind: 'ns-through-right', greenSeconds: 26 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) => issue.path === 'control.plan.phases' && /NEMA-lite/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects duplicate phases', () => {
    const plan = makePlan([
      { kind: 'ns-through-right', greenSeconds: 26 },
      { kind: 'ns-through-right', greenSeconds: 26 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) => issue.path === 'control.plan.phases' && /NEMA-lite/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects a protected-left phase while leftMode is permissive', () => {
    const plan = makePlan([
      { kind: 'ns-protected-left', greenSeconds: 6 },
      { kind: 'ns-through-right', greenSeconds: 20 },
      { kind: 'ew-through-right', greenSeconds: 22 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) => issue.path === 'control.plan.phases' && /NEMA-lite/.test(issue.message),
      ),
    ).toBe(true);
  });

  it("rejects leftMode 'protected' without a dedicated left-only lane on the axis", () => {
    const plan = makePlan(
      [
        { kind: 'ns-protected-left', greenSeconds: 6 },
        { kind: 'ns-through-right', greenSeconds: 20 },
        { kind: 'ew-through-right', greenSeconds: 22 },
      ],
      60,
      { ns: 'protected', ew: 'permissive' },
    );
    // The ring itself matches the (invalid) leftMode, so the ONLY complaint is the lane coherence.
    const issues = issuesOf(withPlan(plan));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('control.plan.leftMode.ns');
    expect(issues[0]?.message).toMatch(/dedicated left-only lane on the north or south arm/);
  });

  it('rejects cycle lengths out of range or non-integer', () => {
    const tooShort = makePlan(
      [
        { kind: 'ns-through-right', greenSeconds: 26 },
        { kind: 'ew-through-right', greenSeconds: 26 },
      ],
      19,
    );
    expect(
      issuesOf(withPlan(tooShort)).some(
        (issue) => issue.path === 'control.plan.cycleLengthSeconds' && />= 20/.test(issue.message),
      ),
    ).toBe(true);

    const fractional = makePlan(
      [
        { kind: 'ns-through-right', greenSeconds: 26 },
        { kind: 'ew-through-right', greenSeconds: 26 },
      ],
      60.5,
    );
    expect(
      issuesOf(withPlan(fractional)).some(
        (issue) =>
          issue.path === 'control.plan.cycleLengthSeconds' && /whole number/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('rejects greens whose total deviates from the cycle length beyond the 0.5 s slack', () => {
    const plan = makePlan([
      { kind: 'ns-through-right', greenSeconds: 40 },
      { kind: 'ew-through-right', greenSeconds: 40 },
    ]);
    expect(
      issuesOf(withPlan(plan)).some(
        (issue) => issue.path === 'control.plan' && /deviation/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('accepts a 4-phase protected plan on arms with dedicated left lanes', () => {
    const splitArm = makeArm(
      [{ designations: ['left'] }, { designations: ['through', 'right'] }],
      { left: 0.2, through: 0.55, right: 0.25 },
    );
    const plan = makePlan(
      [
        { kind: 'ns-protected-left', greenSeconds: 7 },
        { kind: 'ns-through-right', greenSeconds: 15 },
        { kind: 'ew-protected-left', greenSeconds: 7 },
        { kind: 'ew-through-right', greenSeconds: 14 },
      ],
      60,
      { ns: 'protected', ew: 'protected' },
    );
    const config: IntersectionConfig = {
      ...withAllArms(splitArm),
      control: { type: 'signal', plan },
    };
    expect(issuesOf(config)).toEqual([]);
  });
});
