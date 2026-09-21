import type { UsageFacts } from "../static/facts.js";
import type { Check, Requirements } from "../types.js";

/**
 * Checks that ask whether the submission fits inside the platform's documented
 * caps.
 *
 * The usage checks ask "did you reach for the right primitive". These ask "does
 * what you handed it actually fit". That is a different failure mode and a far
 * more common one: the primitive is correct, the shape of the data is not, and
 * the result is a rejected call, a truncated field, or a schedule quota that
 * fills up. Every number here comes from the installed SDK's own limits doc
 * rather than from a guess, and the version-dependent ones are read off the
 * installed package.
 *
 * All of these are conditional on the task actually reaching the cap, so a
 * hundred-item workflow never sees them.
 *
 * Deliberately not checked here: a missing `deduplicationKey` on a runtime
 * schedule, which duplicates a tenant's schedule and burns the project quota.
 * The SDK types make that field required, so the compile gate already rejects
 * it and a check for it could never fire.
 */

function notApplicable(
  id: string,
  title: string,
  why: string,
  category = "limits",
): Check {
  return {
    id,
    category,
    title,
    status: "na",
    expected: "not required by this task",
    actual: "not applicable",
    why,
    evidence: [],
  };
}

/**
 * A single batch call accepts a fixed number of items. A fan-out wider than
 * that has to be split, and the call is rejected outright otherwise, so this is
 * the difference between a fan-out that works and one that never starts.
 */
function analyseBatchSize(facts: UsageFacts, requirements: Requirements): Check {
  const id = "limits.batch_size";
  const title = "Fan-out is split to fit the batch size cap";
  const cap = facts.limits.maxBatchItems;
  const itemCount = requirements.itemCount;

  if (itemCount === undefined || itemCount <= cap) {
    return notApplicable(
      id,
      title,
      `The task fans out ${itemCount ?? "an unstated number of"} items, which fits in a single batch of ${cap}.`,
      "fan-out",
    );
  }

  const batches = facts.dispatchers.flatMap((task) =>
    task.dispatches.filter((dispatch) => dispatch.isBatch),
  );

  if (batches.length === 0) {
    return notApplicable(
      id,
      title,
      "No batch dispatch, so the per-batch cap does not apply. The fan-out check covers this.",
      "fan-out",
    );
  }

  const unchunked = batches.filter((dispatch) => !dispatch.chunked);

  return {
    id,
    category: "fan-out",
    title,
    status: unchunked.length === 0 ? "pass" : "fail",
    mechanism: unchunked.length === 0 ? "platform" : "userland",
    expected: `items split into batches of at most ${cap}`,
    actual:
      unchunked.length === 0
        ? "items are chunked before dispatch"
        : `${itemCount} items handed to a single batch call`,
    why:
      unchunked.length === 0
        ? `The items are split before dispatch, so each batch call stays inside the ${cap}-item cap and the whole fan-out is accepted.`
        : `A single batch call accepts at most ${cap} items and this task has ${itemCount}. The call is rejected, so the fan-out never happens — the primitive is right but it is being handed more than it takes. The items have to be chunked and each chunk dispatched as its own batch.`,
    evidence: unchunked.length === 0 ? batches.map((d) => d.evidence) : unchunked.map((d) => d.evidence),
  };
}

/**
 * Metadata is capped, and exceeding it throws rather than truncating. Progress
 * that accumulates a record per item is the shape that reaches the cap.
 */
function analyseMetadataSize(facts: UsageFacts, requirements: Requirements): Check {
  const id = "limits.metadata_size";
  const title = "Progress reporting stays inside the metadata size cap";
  const capKb = Math.round(facts.limits.maxMetadataBytes / 1024);
  const itemCount = requirements.itemCount;

  if (!requirements.progressMustBeObservable || itemCount === undefined) {
    return notApplicable(
      id,
      title,
      "The task does not require progress to accumulate per item.",
      "observability",
    );
  }

  // Below roughly a hundred items even a generous per-item record fits, so the
  // cap is only a real constraint on the wide fan-outs.
  if (itemCount < 100) {
    return notApplicable(
      id,
      title,
      `With ${itemCount} items, per-item progress records cannot approach the ${capKb}KB cap.`,
      "observability",
    );
  }

  const unbounded = facts.metadataUnboundedWrites;

  return {
    id,
    category: "observability",
    title,
    status: unbounded.length === 0 ? "pass" : "fail",
    mechanism: unbounded.length === 0 ? "platform" : "userland",
    expected: "progress written as counters or replaced values, not per-item records",
    actual:
      unbounded.length === 0
        ? "progress is written as bounded values"
        : `${unbounded.length} metadata write(s) that grow with the item count`,
    why:
      unbounded.length === 0
        ? `Progress is reported by replacing a bounded value rather than accumulating one record per item, so it stays well inside the ${capKb}KB metadata cap however many items there are.`
        : `Run metadata is capped at ${capKb}KB and writing it over that throws rather than truncating. Accumulating a record per item across ${itemCount} items reaches that cap partway through the run, so the workflow fails on a progress update — losing the run for a reason that has nothing to do with the work. Counters, or a replaced summary, report the same thing in constant space.`,
    evidence: unbounded,
  };
}

/**
 * A task's return value is capped too. Carrying every child's output up through
 * the parent multiplies one item's content by the item count.
 */
function analyseOutputSize(facts: UsageFacts, requirements: Requirements): Check {
  const id = "limits.output_size";
  const title = "Aggregated results stay inside the output size cap";
  const capMb = Math.round(facts.limits.maxOutputBytes / (1024 * 1024));

  if (!requirements.itemPayloadIsLarge) {
    return notApplicable(
      id,
      title,
      "The task's items are small, so aggregating their results cannot reach the output cap.",
      "aggregation",
    );
  }

  const aggregated = facts.aggregatedOutputs;

  return {
    id,
    category: "aggregation",
    title,
    status: aggregated.length === 0 ? "pass" : "fail",
    mechanism: aggregated.length === 0 ? "platform" : "userland",
    expected: "the parent returns a summary, not every child's output",
    actual:
      aggregated.length === 0
        ? "child outputs are reduced before being returned"
        : `${aggregated.length} return statement(s) carrying whole child outputs`,
    why:
      aggregated.length === 0
        ? `The parent reduces the child results to the fields it needs, so its return value stays a summary and cannot grow past the ${capMb}MB output cap as items are added.`
        : `A task's return value is capped at ${capMb}MB, and this task's items each carry a large body of content. Returning every child's output whole makes the parent's output the sum of all of them, so the run fails at the very end, after all the work has been paid for. Returning per-item status plus a reference to where the content was written keeps the output flat.`,
    evidence: aggregated,
  };
}

/**
 * The payload cap applies per trigger. Large content has to travel as a
 * reference the child resolves, not as bytes in the payload.
 */
function analysePayloadSize(facts: UsageFacts, requirements: Requirements): Check {
  const id = "limits.payload_size";
  const title = "Large content is passed by reference, not in the payload";
  const capMb = Math.round(facts.limits.maxPayloadBytes / (1024 * 1024));

  if (!requirements.itemPayloadIsLarge) {
    return notApplicable(
      id,
      title,
      "The task's items are small enough to travel inline.",
      "fan-out",
    );
  }

  const inline = facts.inlinePayloadBlobs;

  return {
    id,
    category: "fan-out",
    title,
    status: inline.length === 0 ? "pass" : "fail",
    mechanism: inline.length === 0 ? "platform" : "userland",
    expected: "a key or id in the payload, with the child fetching the content",
    actual:
      inline.length === 0
        ? "payloads carry identifiers rather than content"
        : `${inline.length} payload field(s) carrying file or response bytes`,
    why:
      inline.length === 0
        ? `Payloads carry references rather than content, so they stay small regardless of how large the underlying items are and never approach the ${capMb}MB trigger cap.`
        : `A trigger payload is capped at ${capMb}MB, and this task's items are large bodies of content. Reading the bytes and putting them in the payload makes the trigger fail on exactly the items that matter most, and it pays to move the same content twice. Passing a storage key and letting the child read it keeps the payload flat and the retry cheap.`,
    evidence: inline,
  };
}

/**
 * What an idempotency key protects depends entirely on its scope, and the
 * default is narrower than it looks: a raw string is hashed with the parent run
 * id, so it dedupes across attempts of one run and nothing beyond.
 */
function analyseIdempotencyScope(facts: UsageFacts, requirements: Requirements): Check {
  const id = "limits.idempotency_scope";
  const title = "Idempotency keys are scoped to survive a replay";

  if (!requirements.mustNotDuplicateOnReplay) {
    return notApplicable(id, title, "The task does not require replay safety.", "idempotency");
  }

  const usages = facts.idempotencyScopes;

  if (usages.length === 0) {
    return notApplicable(
      id,
      title,
      "No idempotency key is used at all, which the replay-safety check already reports.",
      "idempotency",
    );
  }

  // Where the key was written only matters for the narrow scopes. Triggering
  // from backend code means there is no parent run to hash against, so run and
  // attempt scope behave globally there and neither is a defect.
  //
  // An explicit global scope is meaningful wherever it appears, and scoping it
  // by lexical position was wrong: key construction is routinely factored into
  // a helper, which sits at module scope even though it only ever runs inside
  // a task. That made a correctly-scoped submission drop out of the score.
  const global = usages.filter((usage) => usage.scope === "global");
  const attempt = usages.filter((usage) => usage.scope === "attempt" && usage.insideTask);
  const run = usages.filter((usage) => usage.scope === "run" && usage.insideTask);

  if (global.length === 0 && attempt.length === 0 && run.length === 0) {
    return notApplicable(
      id,
      title,
      "Keys are only used outside a task, where every scope behaves globally.",
      "idempotency",
    );
  }

  if (attempt.length > 0) {
    return {
      id,
      category: "idempotency",
      title,
      status: "fail",
      mechanism: "userland",
      expected: "keys that stay stable across the retries and replays the task must survive",
      actual: `${attempt.length} attempt-scoped key(s)`,
      why: "These keys are attempt-scoped, which is the one scope that guarantees the opposite of what the task asks for: the key is hashed with the parent's attempt number, so every retry of the parent produces a different key and re-dispatches every child. It is the correct choice when children must re-run on each attempt, and exactly wrong here.",
      evidence: attempt.map((usage) => usage.evidence),
    };
  }

  if (global.length > 0) {
    return {
      id,
      category: "idempotency",
      title,
      status: "pass",
      mechanism: "platform",
      expected: "keys that stay stable across the retries and replays the task must survive",
      actual: `${global.length} globally-scoped key(s)`,
      why: "The keys are globally scoped, so they identify the work itself rather than the run that dispatched it. A retried attempt and a fresh replay both reuse the completed child runs.",
      evidence: global.map((usage) => usage.evidence),
    };
  }

  return {
    id,
    category: "idempotency",
    title,
    status: "fail",
    mechanism: "userland",
    expected: "keys that stay stable across the retries and replays the task must survive",
    actual: `${run.length} run-scoped key(s)`,
    why: "These keys are run-scoped, which is the default for a raw string and narrower than it appears: the key is hashed together with the parent's run id. That covers a retried attempt of the same parent, but a replay is a new run with a new id, so every key changes and every child is dispatched again — the duplication the task rules out, in the case most likely to happen, since replaying a partially-failed parent is the normal way to recover one. Creating the key with global scope ties it to the item instead of the run.",
    evidence: run.map((usage) => usage.evidence),
  };
}

export function analyseLimits(facts: UsageFacts, requirements: Requirements): Check[] {
  return [
    analyseBatchSize(facts, requirements),
    analysePayloadSize(facts, requirements),
    analyseMetadataSize(facts, requirements),
    analyseOutputSize(facts, requirements),
    analyseIdempotencyScope(facts, requirements),
  ];
}
