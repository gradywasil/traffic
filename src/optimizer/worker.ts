/**
 * Sweep worker (task O1) — a dedicated module worker executing whole
 * headless candidate-runs (R2 Part A: "one worker executes whole
 * candidate-runs; message in = {runId, config, repSeed, horizonTicks};
 * message out = {runId, spawnDigest, runHash, metrics}" — realized here as
 * {runId, request} in and {runId, result} out, with `request` carrying
 * (config, masterSeed, repIndex, horizonSeconds) so the worker REGENERATES
 * the paired seed streams from (S, r) rather than receiving traces).
 *
 * The worker imports the SAME sim modules as the main thread (`./run` →
 * `src/sim/*`) — no duplicated simulation logic; structured-clone payloads
 * are plain objects with floats/integers only, so cloning is exact.
 *
 * Vite wiring (R2 Part A pitfalls): this file is referenced ONLY through the
 * static-literal pattern in `executor.ts` —
 *   `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * — which Vite detects and emits as a separate worker chunk. Nothing in the
 * main-thread graph runtime-imports this module (executor imports the
 * message TYPES only), so the worker scope wiring below runs exclusively in
 * the worker. Importing this module under node (unit tests) is side-effect
 * free — `self` does not exist there.
 */
import type { HeadlessRunRequest, HeadlessRunResult } from './run';
import { executeHeadlessRun } from './run';

/** Main → worker: execute one headless run. */
export interface WorkerRunCommand {
  readonly kind: 'run';
  readonly runId: number;
  readonly request: HeadlessRunRequest;
}

export type WorkerInboundMessage = WorkerRunCommand;

/** Worker → main: the run's result, or a failure message for that run. */
export type WorkerOutboundMessage =
  | { readonly kind: 'result'; readonly runId: number; readonly result: HeadlessRunResult }
  | { readonly kind: 'error'; readonly runId: number; readonly message: string };

/**
 * Pure message handler — the worker's entire protocol. Exported so the pool
 * tests drive the REAL handler through fake `Worker` objects (the worker
 * file itself cannot be instantiated under vitest's node environment: node
 * lacks the `Worker` global and cannot resolve the worker's
 * extension-less ESM imports; see executor.test.ts for the honest wiring
 * disclosure and the build evidence for the emitted chunk).
 */
export function handleWorkerMessage(message: WorkerInboundMessage): WorkerOutboundMessage {
  if (message.kind !== 'run') {
    return { kind: 'error', runId: -1, message: `unknown message kind '${String(message.kind)}'` };
  }
  try {
    return { kind: 'result', runId: message.runId, result: executeHeadlessRun(message.request) };
  } catch (error) {
    return {
      kind: 'error',
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The slice of the dedicated-worker global scope this file needs. */
interface WorkerGlobalScopeLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

const workerScope: WorkerGlobalScopeLike | undefined =
  typeof self === 'object' && self !== null && typeof (self as unknown as WorkerGlobalScopeLike).postMessage === 'function'
    ? (self as unknown as WorkerGlobalScopeLike)
    : undefined;

if (workerScope !== undefined) {
  workerScope.onmessage = (event: { readonly data: unknown }): void => {
    workerScope.postMessage(handleWorkerMessage(event.data as WorkerInboundMessage));
  };
}
