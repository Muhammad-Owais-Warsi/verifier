This tsk is run by GPT 5.6 sol


Here's the failure in plain terms.

  The model writes its key as a plain string:

   /home/owais/projects/trigger-bench-v2/trigger-verify-test/src/trigger/tasks.ts lines 292-294

  function syncKey(sync: RegisteredSync): string {
    return `${sync.customerId}:${sync.repositoryId}:${sync.generation}`;
  }

  and passes it straight in:

   /home/owais/projects/trigger-bench-v2/trigger-verify-test/src/trigger/tasks.ts lines 62-65

      await tenantSyncCoordinatorTask.trigger(sync, {
        idempotencyKey: syncKey(sync),
        concurrencyKey: tenantConcurrencyKey,
      });

  That looks like it says "only ever sync this repo once." It doesn't. When you hand Trigger.dev a plain string, it
  doesn't use the string by itself — it quietly mixes in the ID of the run that's doing the triggering. So the real
  key is acme:repo-1:3 + this run's ID, not acme:repo-1:3.

  Now the consequence. Say a sync of 50 repos gets through 30 and then the parent dies.

  • If the platform retries that same parent, it's the same run, same ID, so the keys match and the 30 finished
    repos are correctly skipped. This works.
  • If you replay the parent, you get a brand new run with a brand new ID. Every key changes. Nothing matches. All
    50 repos sync again.

  Replay is the normal way you recover a half-failed sync — it's the button you'd actually press. So the protection
  holds in the case you don't really need it and disappears in the case you do.

  The fix is one call, which ties the key to the repo instead of to the run:

  idempotencyKey: await idempotencyKeys.create(syncKey(sync), { scope: "global" }),

  Worth noting why the model probably didn't do this: it built its own dedup instead, in registerSync, which makes
  requestId idempotent and stamps a generation number. That's a reasonable instinct and it does catch duplicate
  incoming requests, but it's application-level bookkeeping that can't see a replay of an already-accepted sync. The
  platform primitive covers exactly that gap.


```
owais@DESKTOP-CFHRO0C:~/projects/verifier$ npx tsx verifier/run.ts ../trigger-bench-v2/trigger-verify-test github-ingest
Checking the submission compiles against the real SDK...
Analysing how the submission uses Trigger.dev...
Found 6 task(s), 4 queue(s), 0 in-process limiter(s)
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
[PASS        ] Per-item success and failure read from the run results
[PASS        ] One failing item does not abort the others
[PASS        ] Concurrent runs do not share in-process state
[PASS        ] Waiting checkpoints instead of blocking the process
[NA          ] Progress is published through the platform
[NA          ] Cancellation is handled
[NA          ] Waits for an external party without polling
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
               -> src/trigger/tasks.ts:63 raw string key (run scope by default)
               -> src/trigger/tasks.ts:82 raw string key (run scope by default)

Score 0.938 (15 passed, 1 failed, 13 n/a)
```
