import {
  BATCH_METHODS,
  effectiveConcurrencyLimit,
  type UsageFacts,
} from "../static/facts.js";
import type { Check, Requirements } from "../types.js";

/**
 * Checks that answer "is this submission actually using Trigger.dev, and using
 * it the way the framework intends" from the source itself.
 *
 * Each check names the mechanism it found, so a submission that produces the
 * right behaviour the wrong way reads as a failure rather than a pass.
 */

function analyseDecomposition(facts: UsageFacts, requirements: Requirements): Check {
  const inlineWork = facts.tasks.flatMap((task) => task.inlineParallelism);
  const hasWorkerTask = facts.workers.length > 0;

  if (facts.tasks.length === 0) {
    return {
      id: "usage.work_split_into_tasks",
      category: "decomposition",
      title: "Per-item work runs as its own task",
      status: "fail",
      mechanism: "absent",
      expected: "a task per unit of work, dispatched by an orchestrator",
      actual: "no task() definitions found",
      why: "Nothing in the submission defines a Trigger.dev task, so the platform has nothing to run.",
      evidence: [],
    };
  }

  if (!hasWorkerTask) {
    return {
      id: "usage.work_split_into_tasks",
      category: "decomposition",
      title: "Per-item work runs as its own task",
      status: "fail",
      mechanism: "userland",
      expected: `each of the ${requirements.itemCount ?? "N"} items dispatched to a child task`,
      actual: `${facts.tasks.length} task(s) defined, none dispatched by another`,
      why: "All the work happens inside a single task, so the per-item processing is plain in-process JavaScript. The platform cannot schedule, retry, or observe individual items, which is the entire reason to use Trigger.dev for this.",
      evidence: inlineWork.length > 0 ? inlineWork : facts.tasks.map((t) => t.evidence),
    };
  }

  return {
    id: "usage.work_split_into_tasks",
    category: "decomposition",
    title: "Per-item work runs as its own task",
    status: "pass",
    mechanism: "platform",
    expected: "a task per unit of work, dispatched by an orchestrator",
    actual: `orchestrator "${facts.orchestrator?.taskId ?? "?"}" dispatches ${facts.workers
      .map((w) => `"${w.taskId ?? w.name}"`)
      .join(", ")}`,
    why: "Per-item work is dispatched to its own task, so each item becomes a run the platform can schedule, retry and observe independently.",
    evidence: facts.workers.map((w) => w.evidence),
  };
}

function analyseFanOut(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustDispatchItemsTogether) {
    return {
      id: "usage.fan_out_batched",
      category: "fan-out",
      title: "Fan-out uses a batch trigger",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not require items to be dispatched together.",
      evidence: [],
    };
  }

  // Every dispatcher, not just the fan-out task: a pipeline may forward a
  // single run from a router and batch a level deeper, and batching anywhere
  // satisfies the requirement.
  const dispatches = facts.dispatchers.flatMap((task) => task.dispatches);

  // Reporting this as n/a would drop it from the score, so a submission that
  // never fans out would be graded on fewer checks for having failed harder.
  if (dispatches.length === 0) {
    return {
      id: "usage.fan_out_batched",
      category: "fan-out",
      title: "Fan-out uses a batch trigger",
      status: "fail",
      mechanism: "absent",
      expected: "batchTrigger or batchTriggerAndWait",
      actual: "no task dispatches found",
      why: "The task requires the items to be dispatched together, but nothing is dispatched to a child task at all, so there is no fan-out to batch.",
      evidence: facts.tasks.map((t) => t.evidence),
    };
  }

  const batched = dispatches.filter((d) => BATCH_METHODS.has(d.method));
  const sequential = dispatches.filter((d) => d.inSequentialLoop);
  const methods = [...new Set(dispatches.map((d) => d.method))];

  if (batched.length > 0) {
    return {
      id: "usage.fan_out_batched",
      category: "fan-out",
      title: "Fan-out uses a batch trigger",
      status: "pass",
      mechanism: "platform",
      expected: "batchTrigger or batchTriggerAndWait",
      actual: `uses ${methods.join(", ")}`,
      why: "Items are dispatched in a single batch call, which is the intended fan-out primitive and costs one API round trip instead of one per item.",
      evidence: batched.map((d) => d.evidence),
    };
  }

  return {
    id: "usage.fan_out_batched",
    category: "fan-out",
    title: "Fan-out uses a batch trigger",
    status: "fail",
    mechanism: "userland",
    expected: "batchTrigger or batchTriggerAndWait",
    actual: `dispatches one at a time using ${methods.join(", ")}${
      sequential.length > 0 ? `, awaited inside a loop` : ""
    }`,
    why:
      sequential.length > 0
        ? "Items are triggered one at a time and awaited inside a loop, which serialises the whole workflow: each item waits for the previous one to finish. A batch trigger dispatches them together."
        : "Items are triggered individually rather than as a batch. That is one API round trip per item, and the platform cannot treat them as a single unit.",
    evidence: dispatches.map((d) => d.evidence),
  };
}

function analyseConcurrency(facts: UsageFacts, requirements: Requirements): Check {
  const required = requirements.maxConcurrent;
  const managedOnly = requirements.concurrencyMustBeManaged;

  if (required === undefined && !managedOnly) {
    return {
      id: "usage.concurrency_via_queue",
      category: "concurrency",
      title: "Concurrency limited by a Trigger.dev queue",
      status: "na",
      expected: "no concurrency requirement declared",
      actual: "not applicable",
      why: "The task does not state a concurrency requirement.",
      evidence: [],
    };
  }

  const expectedQueueText =
    required === undefined
      ? "a queue with a concurrencyLimit"
      : `a queue with concurrencyLimit ${required}`;

  const handRolled = facts.handRolledLimiters;
  const limits = facts.workers.map((worker) => ({
    worker,
    ...effectiveConcurrencyLimit(worker, facts.queues),
  }));
  // With no stated number, any platform-declared limit satisfies the requirement.
  const matching =
    required === undefined
      ? limits.filter((entry) => typeof entry.limit === "number")
      : limits.filter((entry) => entry.limit === required);
  const declaredQueueLimits = facts.queues
    .map((q) => q.concurrencyLimit)
    .filter((limit): limit is number => typeof limit === "number");

  // When the task states no number there is no value to mismatch, so a queue
  // declaring any limit satisfies the requirement wherever it sits. Requiring it
  // on a dispatched worker conflated this with the decomposition check and
  // reported a submission whose only task carries a queue as having the "wrong
  // value" against an undefined number.
  const satisfiedWithoutNumber = required === undefined && declaredQueueLimits.length > 0;

  if (handRolled.length > 0) {
    return {
      id: "usage.concurrency_via_queue",
      category: "concurrency",
      title: "Concurrency limited by a Trigger.dev queue",
      status: "fail",
      mechanism: "userland",
      expected: expectedQueueText,
      actual: `an in-process limiter${
        matching.length > 0 ? " alongside a queue" : " and no matching queue limit"
      }`,
      why: `The concurrency cap is enforced by the submission's own code rather than by a Trigger.dev queue. An in-process limiter only constrains a single worker process: run two workers and the real concurrency doubles. A queue's concurrencyLimit is enforced by the platform across every worker.`,
      evidence: handRolled,
    };
  }

  if (matching.length > 0 || satisfiedWithoutNumber) {
    return {
      id: "usage.concurrency_via_queue",
      category: "concurrency",
      title: "Concurrency limited by a Trigger.dev queue",
      status: "pass",
      mechanism: "platform",
      expected: expectedQueueText,
      actual:
        matching.length > 0
          ? matching
              .map((entry) => `${entry.worker.taskId ?? entry.worker.name} -> ${entry.source}`)
              .join("; ")
          : `queue(s) declaring concurrencyLimit ${declaredQueueLimits.join(", ")}`,
      why: `The limit${required === undefined ? "" : ` of ${required}`} is declared on a queue, so the platform enforces it across every worker rather than only within one process.`,
      evidence: facts.queues.map((q) => q.evidence),
    };
  }

  if (facts.queues.length === 0 && limits.every((entry) => entry.limit === undefined)) {
    return {
      id: "usage.concurrency_via_queue",
      category: "concurrency",
      title: "Concurrency limited by a Trigger.dev queue",
      status: "fail",
      mechanism: "absent",
      expected: expectedQueueText,
      actual: "no queue or concurrency limit declared anywhere",
      why: `The task requires concurrency to be bounded${
        required === undefined ? "" : ` at ${required}`
      }, but nothing declares a limit. Without a queue the work runs at whatever the environment's concurrency limit allows, which for hundreds of items means overwhelming whatever it calls.`,
      evidence: facts.workers.map((w) => w.evidence),
    };
  }

  return {
    id: "usage.concurrency_via_queue",
    category: "concurrency",
    title: "Concurrency limited by a Trigger.dev queue",
    status: "fail",
    mechanism: "platform",
    expected: expectedQueueText,
    actual: `declared limit(s): ${declaredQueueLimits.join(", ") || "none on the worker task"}`,
    why: `A queue is used, but its limit does not match the required ${required}. The right primitive is in place with the wrong value.`,
    evidence: facts.queues.map((q) => q.evidence),
  };
}

function analyseRetries(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.transientFailuresMustRecover) {
    return {
      id: "usage.retries_via_engine",
      category: "retries",
      title: "Retries handled by the platform retry engine",
      status: "na",
      expected: "no retry requirement declared",
      actual: "not applicable",
      why: "The task does not require recovery from transient failures.",
      evidence: [],
    };
  }

  const manualLoops = facts.tasks.flatMap((task) => task.manualRetryLoops);
  const withRetryConfig = facts.tasks.filter((task) => task.hasRetryConfig);

  if (manualLoops.length > 0) {
    return {
      id: "usage.retries_via_engine",
      category: "retries",
      title: "Retries handled by the platform retry engine",
      status: "fail",
      mechanism: "userland",
      expected: "a retry config on the task, with no hand-written retry loop",
      actual: `${manualLoops.length} hand-written retry loop(s)`,
      why: "Failures are caught and retried inside the task body. The platform only ever sees one attempt, so the attempt history, the backoff policy, and per-attempt observability are all lost. Throwing and letting the engine retry gives all of that for free.",
      evidence: manualLoops,
    };
  }

  if (withRetryConfig.length === 0) {
    return {
      id: "usage.retries_via_engine",
      category: "retries",
      title: "Retries handled by the platform retry engine",
      status: "fail",
      mechanism: "absent",
      expected: "a retry config with maxAttempts above 1",
      actual: "no retry configuration on any task",
      why: "The task requires transient failures to recover, but no task declares a retry policy, so a single transient failure permanently fails that item.",
      evidence: facts.workers.map((w) => w.evidence),
    };
  }

  const tooFew = withRetryConfig.filter(
    (task) => typeof task.retryMaxAttempts === "number" && task.retryMaxAttempts <= 1,
  );

  return {
    id: "usage.retries_via_engine",
    category: "retries",
    title: "Retries handled by the platform retry engine",
    status: tooFew.length > 0 ? "fail" : "pass",
    mechanism: "platform",
    expected: "a retry config with maxAttempts above 1",
    actual: withRetryConfig
      .map((task) => `${task.taskId ?? task.name}: maxAttempts ${task.retryMaxAttempts ?? "default"}`)
      .join("; "),
    why:
      tooFew.length > 0
        ? "A retry policy is declared but allows only one attempt, so nothing is ever retried."
        : "Failures are thrown and the platform's retry engine handles them, which preserves the attempt history and applies the configured backoff.",
    evidence: withRetryConfig.map((task) => task.evidence),
  };
}

/**
 * Fire-and-forget versus fan-in.
 *
 * `trigger` returns as soon as the run is enqueued, so an orchestrator using it
 * finishes before its children do. Only the *AndWait variants suspend the
 * parent at a waitpoint and resume it once every child is terminal.
 */
function analyseWaitsForChildren(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustWaitForAllTerminal) {
    return {
      id: "usage.waits_for_children",
      category: "fan-in",
      title: "Orchestrator waits for every child to finish",
      status: "na",
      expected: "no fan-in requirement declared",
      actual: "not applicable",
      why: "The task does not require the orchestrator to wait for children.",
      evidence: [],
    };
  }

  const dispatches = facts.orchestrator?.dispatches ?? [];
  if (dispatches.length === 0) {
    return {
      id: "usage.waits_for_children",
      category: "fan-in",
      title: "Orchestrator waits for every child to finish",
      status: "fail",
      mechanism: "absent",
      expected: "triggerAndWait or batchTriggerAndWait",
      actual: "no task dispatches found",
      why: "Nothing is dispatched to child tasks, so there is no platform fan-in at all.",
      evidence: facts.tasks.map((t) => t.evidence),
    };
  }

  const fireAndForget = dispatches.filter((d) => !/AndWait$/.test(d.method));

  return {
    id: "usage.waits_for_children",
    category: "fan-in",
    title: "Orchestrator waits for every child to finish",
    status: fireAndForget.length === 0 ? "pass" : "fail",
    mechanism: fireAndForget.length === 0 ? "platform" : "userland",
    expected: "every dispatch uses an *AndWait variant",
    actual: `${dispatches.length - fireAndForget.length}/${dispatches.length} dispatches wait`,
    why:
      fireAndForget.length === 0
        ? "The orchestrator suspends at a waitpoint until every child run is terminal, which also releases its concurrency slot while it waits."
        : "Some children are dispatched without waiting, so the orchestrator can finish before they do. Its summary would then describe work that has not happened yet.",
    evidence: fireAndForget.map((d) => d.evidence),
  };
}

function analyseAggregation(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustReportPerItemOutcome) {
    return {
      id: "usage.per_item_outcome",
      category: "aggregation",
      title: "Per-item success and failure read from the run results",
      status: "na",
      expected: "no per-item reporting requirement declared",
      actual: "not applicable",
      why: "The task does not require a per-item summary.",
      evidence: [],
    };
  }

  const orchestrator = facts.orchestrator;

  // Required but structurally impossible is a failure, not an exemption.
  if (!orchestrator) {
    return {
      id: "usage.per_item_outcome",
      category: "aggregation",
      title: "Per-item success and failure read from the run results",
      status: "fail",
      mechanism: "absent",
      expected: "orchestrator inspects each run's ok flag",
      actual: "no orchestrator task identified",
      why: "The task requires a per-item outcome, but no task dispatches others, so there are no run results to read. Whatever the submission reports per item is derived from its own in-process bookkeeping rather than from what the platform recorded.",
      evidence: facts.tasks.map((t) => t.evidence),
    };
  }

  const waitsForResults = orchestrator.dispatches.some((d) => /AndWait$/.test(d.method));

  return {
    id: "usage.per_item_outcome",
    category: "aggregation",
    title: "Per-item success and failure read from the run results",
    status: orchestrator.readsRunOk && waitsForResults ? "pass" : "fail",
    mechanism: orchestrator.readsRunOk && waitsForResults ? "platform" : "userland",
    expected: "waits for the runs and branches on each run's ok flag",
    actual: `${waitsForResults ? "waits for results" : "does not wait for results"}; ${
      orchestrator.readsRunOk ? "reads .ok" : "never reads .ok"
    }`,
    why:
      orchestrator.readsRunOk && waitsForResults
        ? "The orchestrator waits for the child runs and branches on each run's ok flag, so a failed item is reported as failed instead of silently dropped."
        : !waitsForResults
          ? "The orchestrator dispatches without waiting for results, so it cannot know which items succeeded. Any summary it returns is guesswork."
          : "The orchestrator never inspects each run's ok flag. Batch results report per-run success individually; ignoring that means failures are indistinguishable from successes.",
    evidence: [orchestrator.evidence],
  };
}

/** Small helper for the checks that are a simple "was this primitive used". */
function presenceCheck(options: {
  id: string;
  category: string;
  title: string;
  enabled: boolean;
  satisfied: boolean;
  expected: string;
  actualWhenSatisfied: string;
  actualWhenNot: string;
  whyPass: string;
  whyFail: string;
  evidence: Check["evidence"];
  disabledWhy: string;
}): Check {
  if (!options.enabled) {
    return {
      id: options.id,
      category: options.category,
      title: options.title,
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: options.disabledWhy,
      evidence: [],
    };
  }

  return {
    id: options.id,
    category: options.category,
    title: options.title,
    status: options.satisfied ? "pass" : "fail",
    mechanism: options.satisfied ? "platform" : "absent",
    expected: options.expected,
    actual: options.satisfied ? options.actualWhenSatisfied : options.actualWhenNot,
    why: options.satisfied ? options.whyPass : options.whyFail,
    evidence: options.evidence,
  };
}

/**
 * One child failing must not take the others down.
 *
 * batchTriggerAndWait returns a result per run and does not reject, so failure
 * isolation comes from reading each run's ok flag. Calling unwrap() rethrows,
 * which inside a Promise.all aborts the sibling handling.
 */
function analyseFailureIsolation(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.failureMustBeIsolated) {
    return {
      id: "usage.failure_isolated",
      category: "resilience",
      title: "One failing item does not abort the others",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not require failure isolation between items.",
      evidence: [],
    };
  }

  const orchestrator = facts.orchestrator;
  const readsOk = orchestrator?.readsRunOk ?? false;
  const unwraps = facts.unsafeUnwraps;
  const inlineParallelism = facts.tasks.flatMap((t) => t.inlineParallelism);

  if (unwraps.length > 0) {
    return {
      id: "usage.failure_isolated",
      category: "resilience",
      title: "One failing item does not abort the others",
      status: "fail",
      mechanism: "userland",
    expected: "branch on each run's ok flag",
    actual: `${unwraps.length} unwrap() call(s) with siblings in flight`,
    why: "unwrap() rethrows a failed child's error, and here it runs with sibling runs in flight. One failing item then aborts the handling of every other item, which is exactly the behaviour the task rules out. Reading the ok flag keeps each result independent.",
      evidence: unwraps,
    };
  }

  if (inlineParallelism.length > 0 && !readsOk) {
    return {
      id: "usage.failure_isolated",
      category: "resilience",
      title: "One failing item does not abort the others",
      status: "fail",
      mechanism: "userland",
      expected: "branch on each run's ok flag",
      actual: "Promise.all over inline work with no per-item result handling",
      why: "Promise.all rejects as soon as one item throws, discarding the results of everything still in flight.",
      evidence: inlineParallelism,
    };
  }

  return {
    id: "usage.failure_isolated",
    category: "resilience",
    title: "One failing item does not abort the others",
    status: readsOk ? "pass" : "fail",
    mechanism: readsOk ? "platform" : "absent",
    expected: "branch on each run's ok flag",
    actual: readsOk ? "reads the ok flag on each run result" : "never inspects per-run results",
    why: readsOk
      ? "Each run's outcome is inspected individually, so a failed item is recorded as failed while the rest continue."
      : "Nothing inspects per-run results, so there is no way for one item to fail while the others succeed.",
    evidence: orchestrator ? [orchestrator.evidence] : [],
  };
}

/**
 * Concurrent runs must not interfere. Module-scope mutable state is shared by
 * every run in the process and is lost on restart, which breaks both isolation
 * and durability.
 */
function analyseRunIsolation(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustIsolateConcurrentRuns) {
    return {
      id: "usage.runs_isolated",
      category: "isolation",
      title: "Concurrent runs do not share in-process state",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not require isolation between concurrent runs.",
      evidence: [],
    };
  }

  const shared = facts.moduleLevelState;

  return {
    id: "usage.runs_isolated",
    category: "isolation",
    title: "Concurrent runs do not share in-process state",
    status: shared.length === 0 ? "pass" : "fail",
    mechanism: shared.length === 0 ? "platform" : "userland",
    expected: "no task body writing to module-scope state",
    actual:
      shared.length === 0
        ? "state is confined to run payloads and metadata"
        : `${shared.length} module-scope binding(s) written to during a run`,
    why:
      shared.length === 0
        ? "No task writes to module-scope state, so two runs of the same workflow cannot read or overwrite each other's data."
        : "These bindings live at module scope and are written to while a run executes, so they are shared by every run in that process and two concurrent analyses will corrupt each other. They are also lost when the worker restarts, so the workflow cannot be durable.",
    evidence: shared,
  };
}

/**
 * Long waits must checkpoint rather than hold the process open. A sleeping
 * setTimeout keeps the run executing and its concurrency slot occupied, and it
 * does not survive an interruption.
 */
function analyseDurability(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustSurviveInterruption) {
    return {
      id: "usage.durable_waits",
      category: "durability",
      title: "Waiting checkpoints instead of blocking the process",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not require durability across interruption.",
      evidence: [],
    };
  }

  const polling = facts.pollingSleeps;
  const checkpointing =
    facts.waitUsage.length > 0 ||
    (facts.orchestrator?.dispatches ?? []).some((d) => /AndWait$/.test(d.method));

  if (polling.length > 0) {
    return {
      id: "usage.durable_waits",
      category: "durability",
      title: "Waiting checkpoints instead of blocking the process",
      status: "fail",
      mechanism: "userland",
      expected: "wait.for / wait.until or an *AndWait dispatch",
      actual: `${polling.length} in-process sleep or polling loop(s)`,
      why: "Sleeping or polling with setTimeout keeps the run executing, holds its concurrency slot for the whole duration, and is lost if the worker is interrupted. A platform wait checkpoints the run so it can be resumed on another worker.",
      evidence: polling,
    };
  }

  return {
    id: "usage.durable_waits",
    category: "durability",
    title: "Waiting checkpoints instead of blocking the process",
    status: checkpointing ? "pass" : "fail",
    mechanism: checkpointing ? "platform" : "absent",
    expected: "wait.for / wait.until or an *AndWait dispatch",
    actual: checkpointing ? "waits at platform waitpoints" : "no platform waits found",
    why: checkpointing
      ? "Waiting happens at platform waitpoints, so the run is checkpointed and can resume after an interruption."
      : "Nothing waits at a platform waitpoint, so there is no checkpoint from which an interrupted run could resume.",
    evidence: facts.waitUsage,
  };
}

/**
 * Waiting for a person or a webhook is the requirement models most often
 * hand-roll: they park a row in a database and poll it, or sleep in a loop.
 * A waitpoint token is the primitive, and it is completed from outside.
 */
function analyseExternalCompletion(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.mustAwaitExternalCompletion) {
    return {
      id: "usage.external_completion",
      category: "durability",
      title: "Waits for an external party without polling",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task never waits on anything outside the workflow.",
      evidence: [],
    };
  }

  const tokens = facts.waitTokenUsage;

  if (tokens.length > 0) {
    return {
      id: "usage.external_completion",
      category: "durability",
      title: "Waits for an external party without polling",
      status: "pass",
      mechanism: "platform",
      expected: "a waitpoint token completed from outside the run",
      actual: `${tokens.length} waitpoint token call(s)`,
      why: "The run parks on a waitpoint token and is resumed when something outside completes it. Nothing is held open while it waits, and the wait survives a redeploy however long it lasts.",
      evidence: tokens,
    };
  }

  // Polling is the specific wrong answer here, so name it when it is present.
  const polling = facts.pollingSleeps;

  return {
    id: "usage.external_completion",
    category: "durability",
    title: "Waits for an external party without polling",
    status: "fail",
    mechanism: polling.length > 0 ? "userland" : "absent",
    expected: "a waitpoint token completed from outside the run",
    actual:
      polling.length > 0
        ? `${polling.length} polling loop(s) or in-process sleep(s)`
        : "no waitpoint token, and nothing else that waits on an external party",
    why:
      polling.length > 0
        ? "The workflow goes looking for the answer on a timer instead of being told. Each poll keeps the run executing and holding its slot, and an answer that may take days cannot be waited on this way. A waitpoint token inverts it: the run parks and the external caller completes it."
        : "Nothing parks the run on an external event. The task requires waiting for a party outside the workflow for an unbounded time, which needs a waitpoint token that an HTTP handler completes. Without it the wait either blocks a run or is not really a wait at all.",
    evidence: polling.length > 0 ? polling : [],
  };
}

/**
 * A cron in the source is one schedule for everybody. Per-tenant times have to
 * be registered at runtime, which is what schedules.create is for.
 */
function analysePerTenantSchedules(facts: UsageFacts, requirements: Requirements): Check {
  if (!requirements.schedulesMustBePerTenant) {
    return {
      id: "usage.schedules_per_tenant",
      category: "scheduling",
      title: "Schedules are registered per tenant at runtime",
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not require per-tenant schedules.",
      evidence: [],
    };
  }

  const runtime = facts.runtimeScheduleUsage;
  const staticCrons = facts.staticCronUsage;

  if (runtime.length > 0) {
    return {
      id: "usage.schedules_per_tenant",
      category: "scheduling",
      title: "Schedules are registered per tenant at runtime",
      status: "pass",
      mechanism: "platform",
      expected: "schedules created through the SDK at runtime",
      actual: `${runtime.length} runtime schedule call(s)`,
      why: "Schedules are registered through the SDK at runtime, so each tenant carries its own time and timezone and a new tenant starts without a redeploy.",
      evidence: runtime,
    };
  }

  return {
    id: "usage.schedules_per_tenant",
    category: "scheduling",
    title: "Schedules are registered per tenant at runtime",
    status: "fail",
    mechanism: staticCrons.length > 0 ? "userland" : "absent",
    expected: "schedules created through the SDK at runtime",
    actual:
      staticCrons.length > 0
        ? `${staticCrons.length} cron expression(s) hard-coded in the source`
        : "no scheduling at all",
    why:
      staticCrons.length > 0
        ? "The cron is written into the source, so it is one fixed time for every tenant. Covering per-tenant times that way means firing often enough for the earliest tenant and filtering the rest in code, which reintroduces the scheduling logic the platform already provides and cannot honour per-tenant timezones. Runtime-registered schedules give each tenant its own."
        : "Nothing registers a schedule. Per-tenant times that change without a redeploy have to be created through the SDK at runtime.",
    evidence: staticCrons,
  };
}

/**
 * A second queue or scheduler alongside the platform.
 *
 * Unlike an in-process limiter this genuinely works, which is what makes it
 * worth reporting separately: the submission ends up correct and carrying two
 * systems that both claim to own the work.
 */
function analyseExternalOrchestrator(facts: UsageFacts, requirements: Requirements): Check {
  const id = "usage.no_external_orchestrator";
  const category = "decomposition";
  const title = "No second queue or scheduler beside the platform";

  // Only meaningful for a task that is about orchestration in the first place.
  const orchestrationRequired =
    requirements.mustDispatchItemsTogether ||
    requirements.concurrencyMustBeManaged ||
    requirements.maxConcurrent !== undefined ||
    requirements.schedulesMustBePerTenant;

  if (!orchestrationRequired) {
    return {
      id,
      category,
      title,
      status: "na",
      expected: "not required by this task",
      actual: "not applicable",
      why: "The task does not ask for work to be queued or scheduled.",
      evidence: [],
    };
  }

  const external = facts.externalOrchestrators;

  return {
    id,
    category,
    title,
    status: external.length === 0 ? "pass" : "fail",
    mechanism: external.length === 0 ? "platform" : "userland",
    expected: "queueing and scheduling owned by Trigger.dev alone",
    actual:
      external.length === 0
        ? "no competing queue or scheduler"
        : `${external.length} external queue/scheduler dependency(ies)`,
    why:
      external.length === 0
        ? "Queueing and scheduling are the platform's, so there is one place where work is recorded, retried and observed."
        : "A second queue or scheduler is introduced next to Trigger.dev, so the work is owned by two systems at once. Everything the platform gives for free — the run record, the retry history, the concurrency accounting, the dashboard — now covers only half the pipeline, and the two halves drift apart on the first failure. It is also infrastructure to deploy and keep alive for a job the platform already does.",
    evidence: external,
  };
}

export function analyseUsage(facts: UsageFacts, requirements: Requirements): Check[] {
  return [
    analyseDecomposition(facts, requirements),
    analyseExternalOrchestrator(facts, requirements),
    analyseFanOut(facts, requirements),
    analyseConcurrency(facts, requirements),
    analyseRetries(facts, requirements),
    analyseWaitsForChildren(facts, requirements),
    analyseAggregation(facts, requirements),
    analyseFailureIsolation(facts, requirements),
    analyseRunIsolation(facts, requirements),
    analyseDurability(facts, requirements),

    presenceCheck({
      id: "usage.progress_observable",
      category: "observability",
      title: "Progress is published through the platform",
      enabled: Boolean(requirements.progressMustBeObservable),
      satisfied: facts.metadataUsage.length > 0 || facts.realtimeUsage.length > 0,
      expected: "run metadata or a realtime subscription",
      actualWhenSatisfied: `${facts.metadataUsage.length} metadata call(s), ${facts.realtimeUsage.length} realtime call(s)`,
      actualWhenNot: "no metadata or realtime usage",
      whyPass:
        "Progress is written to run metadata or streamed over realtime, so the frontend can follow it without the workflow inventing its own channel.",
      whyFail:
        "Nothing publishes progress through the platform. Trigger.dev exposes run metadata and realtime subscriptions for exactly this, and building a separate channel means progress is invisible in the dashboard and lost on reconnect.",
      evidence: [...facts.metadataUsage, ...facts.realtimeUsage],
      disabledWhy: "The task does not require observable progress.",
    }),

    presenceCheck({
      id: "usage.cancellable",
      category: "lifecycle",
      title: "Cancellation is handled",
      enabled: Boolean(requirements.mustSupportCancellation),
      satisfied: facts.cancellationUsage.length > 0,
      expected: "an onCancel hook or the run's abort signal",
      actualWhenSatisfied: `${facts.cancellationUsage.length} cancellation hook(s)`,
      actualWhenNot: "no cancellation handling",
      whyPass:
        "The workflow reacts to cancellation, so in-flight work stops and is cleaned up rather than continuing invisibly.",
      whyFail:
        "Nothing handles cancellation. Without an onCancel hook or the run's abort signal, cancelling the parent leaves child work running and any external calls in flight.",
      evidence: facts.cancellationUsage,
      disabledWhy: "The task does not require cancellation support.",
    }),

    analyseExternalCompletion(facts, requirements),

    presenceCheck({
      id: "usage.output_streamed",
      category: "observability",
      title: "Partial output is streamed as it is produced",
      enabled: Boolean(requirements.outputMustStreamIncrementally),
      satisfied: facts.streamUsage.length > 0,
      expected: "a platform stream carrying the partial output",
      actualWhenSatisfied: `${facts.streamUsage.length} stream call(s)`,
      actualWhenNot: "no streams, only whole-value updates",
      whyPass:
        "Partial output is piped through a platform stream, so the client receives it as it is produced and a late or reconnecting client can still read it.",
      whyFail:
        "Nothing streams partial output. Writing the finished value to metadata shows the client nothing until the step completes, and a separate socket or polling endpoint has to be built and kept alive to fill the gap. Trigger.dev streams carry incremental output and are replayable on reconnect.",
      evidence: facts.streamUsage,
      disabledWhy: "The task does not require incremental output.",
    }),

    presenceCheck({
      id: "usage.memory_provisioned",
      category: "resources",
      title: "Memory-hungry work is provisioned and recovers",
      enabled: Boolean(requirements.mustProvisionForMemory),
      satisfied: facts.machineUsage.length > 0 && facts.outOfMemoryUsage.length > 0,
      expected: "a machine preset plus retry.outOfMemory",
      actualWhenSatisfied: `${facts.machineUsage.length} machine preset(s), ${facts.outOfMemoryUsage.length} out-of-memory retry policy(ies)`,
      actualWhenNot:
        facts.machineUsage.length > 0
          ? "a machine preset, but no out-of-memory recovery"
          : "no machine preset declared",
      whyPass:
        "The memory-hungry task declares a machine preset and an out-of-memory retry, so it gets the headroom it needs and reruns on a larger machine when it still runs out.",
      whyFail:
        "The task states that this work exhausts its memory, but nothing raises the machine size or handles an out-of-memory failure. Running out of memory is not an ordinary exception and a normal retry repeats it on the same undersized machine, so the item can never succeed.",
      evidence: [...facts.machineUsage, ...facts.outOfMemoryUsage],
      disabledWhy: "The task has no memory-bound work.",
    }),

    analysePerTenantSchedules(facts, requirements),

    presenceCheck({
      id: "usage.work_prioritised",
      category: "concurrency",
      title: "Higher-priority work is served first",
      enabled: Boolean(requirements.mustPrioritiseWork),
      satisfied: facts.priorityUsage.length > 0,
      expected: "priority set when triggering",
      actualWhenSatisfied: `${facts.priorityUsage.length} prioritised trigger(s)`,
      actualWhenNot: "no priority set on any trigger",
      whyPass:
        "Triggers carry a priority, so the platform serves the higher-priority work first instead of the submission having to order the queue itself.",
      whyFail:
        "Nothing sets a priority, so queued work is served in arrival order and the classes the task says must go first will sit behind whatever arrived earlier. Sorting before dispatch does not help: once runs are queued, ordering is the platform's to decide.",
      evidence: facts.priorityUsage,
      disabledWhy: "The task does not rank classes of work.",
    }),

    presenceCheck({
      id: "usage.tenant_throughput_isolated",
      category: "isolation",
      title: "One tenant's volume does not delay another's",
      enabled: Boolean(requirements.mustIsolateTenantThroughput),
      satisfied: facts.concurrencyKeyUsage.length > 0,
      expected: "a concurrency key per tenant",
      actualWhenSatisfied: `${facts.concurrencyKeyUsage.length} per-tenant concurrency key(s)`,
      actualWhenNot: "a single shared queue with no per-tenant key",
      whyPass:
        "Runs carry a per-tenant concurrency key, so each tenant gets its own slice of the queue's limit and a tenant submitting in bulk cannot starve the others.",
      whyFail:
        "A queue limit alone is global: whoever enqueues first holds the slots, so one tenant submitting hundreds of items delays everyone behind them. A per-tenant concurrency key partitions the same limit so tenants progress independently.",
      evidence: facts.concurrencyKeyUsage,
      disabledWhy: "The task is not multi-tenant.",
    }),

    presenceCheck({
      id: "usage.replay_safe",
      category: "idempotency",
      title: "Replaying the parent does not duplicate work",
      enabled: Boolean(requirements.mustNotDuplicateOnReplay),
      satisfied: facts.idempotencyKeyUsage.length > 0,
      expected: "an idempotencyKey on the triggers",
      actualWhenSatisfied: `${facts.idempotencyKeyUsage.length} idempotencyKey usage(s)`,
      actualWhenNot: "no idempotencyKey supplied",
      whyPass:
        "Triggers carry an idempotency key, so a retried parent reuses the completed child runs instead of starting them again.",
      whyFail:
        "Triggers carry no idempotency key. If the parent is retried after some children have finished, every one of them is dispatched again, duplicating the work and any external API calls it made.",
      evidence: facts.idempotencyKeyUsage,
      disabledWhy: "The task does not require replay safety.",
    }),
  ];
}
