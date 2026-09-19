# Verifier

Checks whether a solution **genuinely uses Trigger.dev the right way**, just by reading its source code. Nothing is deployed, nothing is run, no credentials needed.

## How to run

```bash
npm install
npx tsx verifier/run.ts /path/to/solution document-review
```

Task name is the folder under `tasks/` (`document-review`, `evidence-ingest`). Or point at any expectations file directly:

```bash
npx tsx verifier/run.ts /path/to/solution tasks/document-review/expectations.json
```

Reports go to `results/report.json`. Exit `0` = all passed, `1` = checks failed, `2` = verifier crashed.

Self-test (fixtures test the tester itself — see below):

```bash
npm run fixtures   # expect: 163/163 assertions passed across 21 fixtures
```

## The method

- `tasks/setup.md` is shared by all tasks and is the **only** file the solver ever sees.
- `tasks/<name>/expectations.json` states plain requirements (`"mustWaitForAllTerminal": true`, ...) and is never shown to the solver. It never names SDK functions — the verifier figures out which primitive was used by itself. Omit a key and its check reports `n/a` and drops out of the score.

## How it works

1. **Parse** the solution into a tree (AST). **Resolve** every name against the real installed SDK, so aliases count and lookalikes don't.
2. **Facts**: what the code does (tasks defined, who triggers whom, queue limits, `.ok` reads, `setTimeout` polls, ...).
3. **Checks**: is that the right way (e.g. concurrency capped by a queue = `platform` pass; by in-process `p-limit` = `userland` fail).
4. **Gate first**: must compile against real SDK types with no deprecated/v3 APIs, unexported tasks, or direct `task.run()` — else grading stops.

Each check gives `pass`/`fail`/`n/a` plus `why` and `file:line` evidence.

## Checks

Static: `type_checks`, `no_deprecated_apis`, `no_v3_apis`, `tasks_exported`, `no_direct_run_calls`.

Usage: `work_split_into_tasks`, `no_external_orchestrator`, `fan_out_batched`, `concurrency_via_queue`, `retries_via_engine`, `waits_for_children`, `per_item_outcome`, `failure_isolated`, `runs_isolated`, `durable_waits`, `progress_observable`, `cancellable`, `external_completion`, `output_streamed`, `memory_provisioned`, `schedules_per_tenant`, `work_prioritised`, `tenant_throughput_isolated`, `replay_safe`.

Limits (only active when the task reaches the cap): `batch_size`, `payload_size`, `metadata_size`, `output_size`, `idempotency_scope`.

## Fixtures

`fixtures/` are fake solutions with known verdicts (`reference` must pass all; each anti-pattern must fail exactly its target check). If one drifts, the verifier has a bug.

## Adding a task

1. Add the brief to shared `tasks/setup.md`.
2. Add `tasks/<name>/expectations.json` with plain-word requirements.
3. Grade: `npx tsx verifier/run.ts /path/to/solution <name>`.

## UI

Not working yet (`npm run ui`). Use the command line.
