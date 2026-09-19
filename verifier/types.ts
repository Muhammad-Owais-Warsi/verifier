export type CheckStatus = "pass" | "fail" | "na" | "inconclusive";

export type Mechanism = "platform" | "userland" | "absent" | "unknown";

export interface Evidence {
  file?: string;
  line?: number;
  snippet?: string;
  runId?: string;
  dashboard?: string;
}

export interface Check {
  id: string;
  category: string;
  title: string;
  status: CheckStatus;
  /** What the platform should have recorded or done. */
  expected: string;
  /** What it actually recorded or did. */
  actual: string;
  /** Plain-language explanation aimed at a human reading the UI. */
  why: string;
  mechanism?: Mechanism;
  evidence: Evidence[];
}

export interface Report {
  generatedAt: string;
  submission: string;
  score: {
    total: number;
    passed: number;
    failed: number;
    na: number;
    inconclusive: number;
  };
  aborted?: { stage: string; reason: string };
  checks: Check[];
}

/**
 * Requirements are stated in plain terms and never name a Trigger.dev API.
 * Each key switches on one check; omitting a key makes that check report `na`
 * and drop out of the score.
 */
export interface Requirements {
  itemCount?: number;
  /** A specific cap. Use concurrencyMustBeManaged when no number is given. */
  maxConcurrent?: number;
  /** Concurrency must be bounded by the platform, without a fixed number. */
  concurrencyMustBeManaged?: boolean;
  transientFailuresMustRecover?: boolean;
  mustWaitForAllTerminal?: boolean;
  mustReportPerItemOutcome?: boolean;
  /** Items must be handed off together rather than one at a time. */
  mustDispatchItemsTogether?: boolean;
  /** One item failing must not prevent the others from completing. */
  failureMustBeIsolated?: boolean;
  /** Progress must be observable while the workflow runs. */
  progressMustBeObservable?: boolean;
  /** An in-progress workflow must be cancellable. */
  mustSupportCancellation?: boolean;
  /** Must survive the executing process being interrupted. */
  mustSurviveInterruption?: boolean;
  /** Concurrent runs must not share or corrupt each other's state. */
  mustIsolateConcurrentRuns?: boolean;
  /** Re-running the parent must not duplicate completed work. */
  mustNotDuplicateOnReplay?: boolean;

  /**
   * The workflow must pause for something outside it (a person, a webhook) for
   * an unbounded time, without holding compute or polling for the answer.
   */
  mustAwaitExternalCompletion?: boolean;
  /** Partial output must reach the client as it is produced. */
  outputMustStreamIncrementally?: boolean;
  /** Memory-hungry work must be provisioned and must recover when it runs out. */
  mustProvisionForMemory?: boolean;
  /** Each tenant sets its own schedule, changeable without a redeploy. */
  schedulesMustBePerTenant?: boolean;
  /** Some classes of work must be served ahead of others. */
  mustPrioritiseWork?: boolean;
  /** One tenant's volume must not delay another's. */
  mustIsolateTenantThroughput?: boolean;
  /**
   * Each item carries a substantial body of content (a document, a file, a
   * transcript) rather than a handful of fields. Switches on the checks that
   * ask whether the submission designed around the platform's size caps.
   */
  itemPayloadIsLarge?: boolean;
}

export interface Expectations {
  requirements: Requirements;
}

/** A single run in the collected graph, flattened from the management API. */
export interface GraphRun {
  id: string;
  taskIdentifier: string;
  status: string;
  depth: number;
  batchId?: string;
  triggerFunction?: string;
  idempotencyKey?: string;
  isRoot: boolean;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /**
   * Number of attempts the platform's retry engine made. The v4 API exposes a
   * count rather than a per-attempt array. A value above 1 is proof the engine
   * retried; a hand-written retry loop leaves this at 1.
   *
   * Only populated for runs fetched individually, since relatedRuns.children
   * omits it.
   */
  attemptCount?: number;
  output?: unknown;
}

export interface RunGraph {
  label: string;
  rootRunId: string;
  wallClockMs: number;
  runs: GraphRun[];
  /** Statuses the root passed through, sampled while polling. */
  rootStatusHistory: string[];
}

export interface QueueSnapshot {
  id: string;
  name: string;
  type: string;
  concurrencyLimit: number | null;
}

/** Matches the v4 status enum in @trigger.dev/core/v3. */
export const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
