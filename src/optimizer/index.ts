/**
 * Optimizer public API (task O1): candidate space, headless runs, the sweep
 * executors (worker pool default, time-sliced fallback) and the paired-seed
 * sweep orchestration. O2's UI consumes exactly this surface.
 *
 * NOTE on the worker: `./worker` is re-exported TYPE-ONLY so that importing
 * this barrel from the main thread never runtime-loads the worker module —
 * the worker chunk is emitted solely through the static-literal
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * pattern inside `executor.ts` (Vite requirement, R2 Part A).
 */
export {
  DEFAULT_MAX_CANDIDATES,
  candidateConfig,
  candidateCycleSeconds,
  greenSplitSpace,
  refineCandidates,
  ringPhaseKinds,
  usableGreenSeconds,
} from './candidates';
export type { CandidateSpaceOptions, GreenSplitSpace, RefineOptions, SweepCandidate } from './candidates';
export { createHeadlessRun, executeHeadlessRun, horizonTicks } from './run';
export type { HeadlessRunHandle, HeadlessRunRequest, HeadlessRunResult } from './run';
export {
  SweepCancelledError,
  TimeSlicedExecutor,
  WorkerPoolExecutor,
  defaultWorkerPoolSize,
} from './executor';
export type {
  SweepExecutor,
  SweepRunCallbacks,
  SweepRunRequest,
  SweepRunResult,
  SweepWorkerFactory,
  TimeSlicedOptions,
  WorkerPoolOptions,
} from './executor';
export type { WorkerInboundMessage, WorkerOutboundMessage, WorkerRunCommand } from './worker';
export {
  DEFAULT_SWEEP_HORIZON_SECONDS,
  DEFAULT_SWEEP_REPS,
  PairingViolationError,
  runDefaultSweep,
  runSweep,
} from './sweep';
export type {
  CandidateRepOutcome,
  CandidateSweepResult,
  DefaultSweepOptions,
  SweepOptions,
  SweepProgress,
  SweepReport,
} from './sweep';
