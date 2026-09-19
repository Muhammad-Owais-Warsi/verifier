/**
 * The verifier's own test suite.
 *
 * Each fixture is a deliberately-shaped submission with a known verdict. If a
 * fixture stops producing its expected statuses the verifier has a bug, and
 * without this a broken check is indistinguishable from a real model failure.
 *
 * Every anti-pattern fixture must fail the check it targets *and* pass the
 * others, so a check that fires too broadly is caught here too.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "../verifier/run.js";
import type { CheckStatus, Requirements } from "../verifier/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixtures declare the requirements they are graded against rather than
 * inheriting a task's expectations.json, so the suite keeps testing the same
 * behaviour when the real tasks change.
 */
const BATCH_REQUIREMENTS: Requirements = {
  itemCount: 100,
  maxConcurrent: 5,
  transientFailuresMustRecover: true,
  mustWaitForAllTerminal: true,
  mustReportPerItemOutcome: true,
  mustDispatchItemsTogether: true,
};

/** Adds the durability, observability and isolation requirements. */
const DURABLE_REQUIREMENTS: Requirements = {
  concurrencyMustBeManaged: true,
  transientFailuresMustRecover: true,
  mustWaitForAllTerminal: true,
  mustReportPerItemOutcome: true,
  mustDispatchItemsTogether: true,
  failureMustBeIsolated: true,
  progressMustBeObservable: true,
  mustSupportCancellation: true,
  mustSurviveInterruption: true,
  mustIsolateConcurrentRuns: true,
  mustNotDuplicateOnReplay: true,
};

/** The document-review task: everything above, plus the advanced primitives. */
const ADVANCED_REQUIREMENTS: Requirements = {
  ...DURABLE_REQUIREMENTS,
  mustAwaitExternalCompletion: true,
  outputMustStreamIncrementally: true,
  mustProvisionForMemory: true,
  schedulesMustBePerTenant: true,
  mustPrioritiseWork: true,
  mustIsolateTenantThroughput: true,
};

/**
 * A fan-out wide enough, and items large enough, for the platform's caps to
 * bind. The limit checks stay n/a below these thresholds, so they need a task
 * that actually reaches them.
 */
const LIMIT_REQUIREMENTS: Requirements = {
  ...ADVANCED_REQUIREMENTS,
  itemCount: 5000,
  itemPayloadIsLarge: true,
};

interface FixtureExpectation {
  note: string;
  requirements?: Requirements;
  /** Check id -> required status. Unlisted checks are not asserted. */
  checks: Record<string, CheckStatus>;
}

const FIXTURES: Record<string, FixtureExpectation> = {
  reference: {
    note: "Correct submission. Must pass everything.",
    checks: {
      "static.type_checks": "pass",
      "static.no_deprecated_apis": "pass",
      "static.no_v3_apis": "pass",
      "static.tasks_exported": "pass",
      "static.no_direct_run_calls": "pass",
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.per_item_outcome": "pass",
    },
  },
  "promise-all-monolith": {
    note: "One task doing everything with Promise.allSettled.",
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "fail",
      "usage.concurrency_via_queue": "fail",
      "usage.retries_via_engine": "fail",
      // Must fail rather than report n/a: dropping these from the score would
      // grade a monolith on fewer checks than a real attempt.
      "usage.fan_out_batched": "fail",
      "usage.per_item_outcome": "fail",
    },
  },
  "p-limit-semaphore": {
    note: "Real child tasks, but concurrency capped by an in-process worker pool.",
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "pass",
      "usage.concurrency_via_queue": "fail",
      "usage.retries_via_engine": "pass",
      "usage.per_item_outcome": "pass",
    },
  },
  "manual-retry-loop": {
    note: "Correct queue and batching, but retries hand-written in the task body.",
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "fail",
      "usage.per_item_outcome": "pass",
    },
  },
  "direct-run": {
    note: "Calls task.run() directly, bypassing the platform.",
    checks: {
      "static.no_direct_run_calls": "fail",
      "static.tasks_exported": "pass",
    },
  },
  "unexported-task": {
    note: "Child task is not exported, so it never registers.",
    checks: {
      "static.tasks_exported": "fail",
      "usage.fan_out_batched": "pass",
    },
  },
  "v3-apis": {
    note: "Written against the removed v2/v3 API surface.",
    checks: {
      "static.no_v3_apis": "fail",
    },
  },
  aliased: {
    note: "Correct, but every SDK import is aliased and a local is named `metadata`.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "static.tasks_exported": "pass",
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.runs_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.progress_observable": "pass",
      "usage.cancellable": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "routed-pipeline": {
    note: "Router forwards one run; the real fan-out is a level deeper.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "pass",
      // The router's single trigger must not read as a failed fan-out.
      "usage.fan_out_batched": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.cancellable": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "advanced-reference": {
    note: "Satisfies the advanced requirements with the platform primitives.",
    requirements: ADVANCED_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.external_completion": "pass",
      "usage.output_streamed": "pass",
      "usage.memory_provisioned": "pass",
      "usage.schedules_per_tenant": "pass",
      "usage.work_prioritised": "pass",
      "usage.tenant_throughput_isolated": "pass",
      "usage.replay_safe": "pass",
      "usage.failure_isolated": "pass",
      // Globally-scoped keys must be recognised here too, not just in the
      // fixture built for the limit checks.
      "limits.idempotency_scope": "pass",
    },
  },
  "polled-approval": {
    note: "Polls for approval, publishes whole values, one cron, shared queue.",
    requirements: ADVANCED_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      // Correct on the basics, so the advanced checks are what separate them.
      "usage.fan_out_batched": "pass",
      "usage.per_item_outcome": "pass",
      "usage.external_completion": "fail",
      "usage.output_streamed": "fail",
      "usage.memory_provisioned": "fail",
      "usage.schedules_per_tenant": "fail",
      "usage.work_prioritised": "fail",
      "usage.tenant_throughput_isolated": "fail",
    },
  },
  "scheduled-orchestrator": {
    note: "Correct, but orchestrated by schedules.task with options built in a loop.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.runs_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.progress_observable": "pass",
      "usage.cancellable": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "durable-reference": {
    note: "Correct durable submission. Must pass every durability check.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.failure_isolated": "pass",
      "usage.runs_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.progress_observable": "pass",
      "usage.cancellable": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "unwrap-siblings": {
    note: "unwrap() inside Promise.all, so one failure aborts the rest.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.failure_isolated": "fail",
      "usage.runs_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.progress_observable": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "module-state": {
    note: "Accumulates progress in module-scope state shared across runs.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.runs_isolated": "fail",
      "usage.failure_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.cancellable": "pass",
    },
  },
  "polling-orchestrator": {
    note: "Polls the API in a sleep loop instead of waiting at a waitpoint.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.durable_waits": "fail",
      "usage.concurrency_via_queue": "pass",
      "usage.runs_isolated": "pass",
      "usage.replay_safe": "pass",
    },
  },
  "batch-namespace": {
    note: "Mixed fan-out via the batch namespace, env-configured queue limit.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.work_split_into_tasks": "pass",
      // The limit is Number(process.env...), not a literal.
      "usage.concurrency_via_queue": "pass",
      // batch.triggerByTaskAndWait is a batch dispatch and an orchestrator.
      "usage.fan_out_batched": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      // Promise.all here builds the items; the drain loop is local work.
      "usage.failure_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.replay_safe": "pass",
      "limits.idempotency_scope": "pass",
    },
  },
  "shorthand-config": {
    note: "Shared retry/queue consts applied with shorthand, key from a helper.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      // The bug: shorthand `{ retry }` read as no retry policy at all.
      "usage.retries_via_engine": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.fan_out_batched": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.cancellable": "pass",
      "usage.replay_safe": "pass",
      "limits.idempotency_scope": "pass",
    },
  },
  "helper-built-key": {
    note: "Same shape, but the key helper returns a plain string (run scope).",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.retries_via_engine": "pass",
      "usage.replay_safe": "pass",
      // Must be graded, not skipped: a non-literal key used to report n/a.
      "limits.idempotency_scope": "fail",
    },
  },
  "v3-reflexes": {
    note: "Correct structure, expressed with the APIs the SDK renamed.",
    requirements: ADVANCED_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      // Catches metadata.stream / metadata.save by reference, and onStart /
      // handleError as config keys, which suggestion diagnostics alone miss.
      "static.no_deprecated_apis": "fail",
      // Every structural choice is right, so nothing else may fire.
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.cancellable": "pass",
      "usage.progress_observable": "pass",
    },
  },
  "external-broker": {
    note: "Real tasks, but queueing and the concurrency cap handed to BullMQ.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.no_external_orchestrator": "fail",
      // The cap is enforced, just not by the platform.
      "usage.concurrency_via_queue": "fail",
    },
  },
  "limit-violations": {
    note: "Right primitive everywhere, but each one handed more than it accepts.",
    requirements: LIMIT_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      // The usage checks must all pass, so the limit checks are what separate
      // this from a correct submission.
      "usage.work_split_into_tasks": "pass",
      "usage.fan_out_batched": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.retries_via_engine": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.cancellable": "pass",
      "usage.progress_observable": "pass",
      "usage.schedules_per_tenant": "pass",
      "usage.replay_safe": "pass",
      "limits.batch_size": "fail",
      "limits.payload_size": "fail",
      "limits.metadata_size": "fail",
      "limits.output_size": "fail",
      "limits.idempotency_scope": "fail",
    },
  },
  "limit-compliant": {
    note: "The same workflow designed around the caps.",
    requirements: LIMIT_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      // Chunking awaits a batch per loop iteration, which must not read as a
      // fan-out that failed to batch.
      "usage.fan_out_batched": "pass",
      "usage.waits_for_children": "pass",
      "usage.per_item_outcome": "pass",
      "usage.failure_isolated": "pass",
      "usage.progress_observable": "pass",
      "usage.replay_safe": "pass",
      "limits.batch_size": "pass",
      "limits.payload_size": "pass",
      "limits.metadata_size": "pass",
      "limits.output_size": "pass",
      "limits.idempotency_scope": "pass",
    },
  },
  "no-observability": {
    note: "Well orchestrated, but no progress, cancellation or replay safety.",
    requirements: DURABLE_REQUIREMENTS,
    checks: {
      "static.type_checks": "pass",
      "usage.concurrency_via_queue": "pass",
      "usage.failure_isolated": "pass",
      "usage.durable_waits": "pass",
      "usage.progress_observable": "fail",
      "usage.cancellable": "fail",
      "usage.replay_safe": "fail",
    },
  },
};

let failures = 0;
let assertions = 0;

for (const [name, expectation] of Object.entries(FIXTURES)) {
  const report = await verify({
    submissionDir: path.join(HERE, name),
    requirements: expectation.requirements ?? BATCH_REQUIREMENTS,
    persist: false,
    onProgress: () => {},
  });
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  console.log(`\n${name}  -- ${expectation.note}`);

  for (const [checkId, expectedStatus] of Object.entries(expectation.checks)) {
    assertions++;
    const actual = byId.get(checkId);

    if (!actual) {
      failures++;
      console.log(`  MISSING  ${checkId} (expected ${expectedStatus})`);
      continue;
    }

    if (actual.status !== expectedStatus) {
      failures++;
      console.log(`  WRONG    ${checkId}: expected ${expectedStatus}, got ${actual.status}`);
      console.log(`           ${actual.why.split("\n")[0]}`);
      continue;
    }

    console.log(`  ok       ${checkId} = ${expectedStatus}`);
  }
}

console.log(
  `\n${assertions - failures}/${assertions} assertions passed across ${
    Object.keys(FIXTURES).length
  } fixtures`,
);

process.exit(failures > 0 ? 1 : 0);
