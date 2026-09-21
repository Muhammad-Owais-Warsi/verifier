This task is run by Opus 5.

Score 0.882 — 15 passed, 2 failed, 13 N/A. 33 tasks, 15 queues, compiles clean, no v3 imports. Strongest submission so far.

What failed:

Idempotency keys are run-scoped.
Seven dispatch sites use raw keys like:
issue:${application.id}, print:${dlNumber}, digilocker:${dlNumber}.

`Raw strings are run-scoped by default. This works for retries of the same run, but a replay creates a new run, so the same key becomes different and the licence could be issued/printed/registered again.`

Fix: use idempotencyKeys.create(id, { scope: "global" }) for operations that must happen only once per licence.

Progress is not published through Trigger.dev.
The submission has its own notifications/ module and status tracking, so the citizen is still informed. However, it does not use Trigger.dev metadata/realtime, meaning progress is not visible through the Trigger.dev dashboard.

This is questionable because the task only says "Proper updates", which can reasonably mean notifying the applicant. So this may be stricter than what the task actually required.

Honest assessment: 0.941, with one real failure.



```
Found 33 task(s), 15 queue(s), 0 in-process limiter(s)
Report written to results/report.json

[PASS        ] Compiles against the real Trigger.dev SDK types
[PASS        ] No deprecated Trigger.dev SDK symbols
[PASS        ] No v3-era Trigger.dev APIs
[PASS        ] Tasks are exported so the platform can register them
[PASS        ] Tasks are not invoked by calling run() directly
[PASS        ] Per-item work runs as its own task
[PASS        ] No second queue or scheduler beside the platform
[NA          ] Fan-out uses a batch trigger
[PASS        ] Concurrency limited by a Trigger.dev queue
[PASS        ] Retries handled by the platform retry engine
[NA          ] Orchestrator waits for every child to finish
[NA          ] Per-item success and failure read from the run results
[NA          ] One failing item does not abort the others
[PASS        ] Concurrent runs do not share in-process state
[PASS        ] Waiting checkpoints instead of blocking the process
[FAIL        ] Progress is published through the platform
               Nothing publishes progress through the platform. Trigger.dev exposes run metadata and realtime subscriptions for exactly this, and building a separate channel means progress is invisible in the dashboard and lost on reconnect.
[NA          ] Cancellation is handled
[PASS        ] Waits for an external party without polling
[PASS        ] Waiting on an outside party has a deadline
[NA          ] Partial output is streamed as it is produced
[NA          ] Memory-hungry work is provisioned and recovers
[NA          ] Schedules are registered per tenant at runtime
[NA          ] Higher-priority work is served first
[PASS        ] One tenant's volume does not delay another's
[PASS        ] Replaying the parent does not duplicate work
[NA          ] Fan-out is split to fit the batch size cap
[NA          ] Large content is passed by reference, not in the payload
[NA          ] Progress reporting stays inside the metadata size cap
[NA          ] Aggregated results stay inside the output size cap
[FAIL        ] Idempotency keys are scoped to survive a replay
               These keys are run-scoped, which is the default for a raw string and narrower than it appears: the key is hashed together with the parent's run id. That covers a retried attempt of the same parent, but a replay is a new run with a new id, so every key changes and every child is dispatched again — the duplication the task rules out, in the case most likely to happen, since replaying a partially-failed parent is the normal way to recover one. Creating the key with global scope ties it to the item instead of the run.
               -> src/trigger/applications/advance.ts:64 raw string key (run scope by default)
               -> src/trigger/issuance/dispatch.ts:49 raw string key (run scope by default)
               -> ... and 5 more (see results/report.json)

Score 0.882 (15 passed, 2 failed, 13 n/a)
```
