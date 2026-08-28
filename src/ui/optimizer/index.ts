/**
 * Optimizer UI (task O2): sweep service (default-sweep orchestration with a
 * measured current-plan baseline), the DOM-free optimizer state machine +
 * results view model, and the DOM panel. Wired into the app shell by
 * `src/ui/app.ts`.
 */
export {
  createOptimizerSweepService,
  currentPlanCandidate,
  findCurrentRow,
} from './sweep-service';
export type {
  CurrentPlanMeasurement,
  OptimizerCurrentPlanResult,
  OptimizerServiceOptions,
  OptimizerSweepOutcome,
  OptimizerSweepProgress,
  OptimizerSweepService,
  OptimizerSweepTuning,
} from './sweep-service';
export { OptimizerModel, buildResultsView } from './optimizer-model';
export type {
  OptimizerModelOptions,
  OptimizerPhase,
  OptimizerResultsView,
  OptimizerRowView,
} from './optimizer-model';
export { OptimizerPanel } from './optimizer-panel';
