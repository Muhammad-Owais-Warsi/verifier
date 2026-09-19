Four of the six come from one decision: every stage fires the next with trigger() and immediately forgets it.
  Nobody ever waits, so the pipeline has to track itself in Postgres.

  1. Nothing waits for the children. Encoding five formats starts five runs and the parent walks away. To answer
  "are all formats ready?", each encode writes to the database and the finalize step counts rows. The platform can
  do this for you and tell you when all five are done.

  2. It can't tell which format succeeded. Because it never waits, it never sees the results. It reads status out of
  its own database table instead, which is only as correct as its own bookkeeping.

  3. One failure doesn't cleanly spare the others. Same cause: with no results to inspect, there's no place where it
  says "this one failed, the rest are fine."

  4. Big videos still crash. The model did raise the machine size, which is the right instinct. But if a video is
  too big even for that, the retry runs on the same machine and crashes again, forever. You need to tell it to retry
  on a bigger machine.

  5. One user can still hog everything. There's a limit of 2 encodes at once, but it's one shared limit for
  everybody. Upload 100 videos and you hold both slots while everyone waits. The fix is tagging each job with its
  user so the limit applies per user.

  6. The same video still downloads twice. This is the one the task was really about. The model does the hard part
  right — it hashes the video content and uses that as the key, so two users uploading the same file should collide.
  But a plain string key gets silently combined with the id of the run that created it. Two users means two
  different runs, so the keys don't match, and it downloads twice anyway. Right idea, undone by a default.


  ```
  owais@DESKTOP-CFHRO0C:~/projects/verifier$ npx tsx verifier/run.ts ../trigger-bench-v2/trigger-verify-test video-transcode
  Checking the submission compiles against the real SDK...
  Analysing how the submission uses Trigger.dev...
  Found 7 task(s), 1 queue(s), 0 in-process limiter(s)
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
  [FAIL        ] Orchestrator waits for every child to finish
                 Some children are dispatched without waiting, so the orchestrator can finish before they do. Its summary would then describe work that has not happened yet.
                 -> src/trigger/video.ts:160 downloadVideo.trigger(
                 -> src/trigger/video.ts:165 finalizeAsset.trigger(
  [FAIL        ] Per-item success and failure read from the run results
                 The orchestrator dispatches without waiting for results, so it cannot know which items succeeded. Any summary it returns is guesswork.
                 -> src/trigger/video.ts:121 submitVideo = task({
  [FAIL        ] One failing item does not abort the others
                 Nothing inspects per-run results, so there is no way for one item to fail while the others succeed.
                 -> src/trigger/video.ts:121 submitVideo = task({
  [PASS        ] Concurrent runs do not share in-process state
  [NA          ] Waiting checkpoints instead of blocking the process
  [PASS        ] Progress is published through the platform
  [NA          ] Cancellation is handled
  [NA          ] Waits for an external party without polling
  [NA          ] Partial output is streamed as it is produced
  [FAIL        ] Memory-hungry work is provisioned and recovers
                 The task raises the machine size but does nothing when that is still not enough. Running out of memory is not an ordinary exception: a normal retry repeats it on the same machine, so an item too big for the preset can never succeed. An out-of-memory retry reruns it on a larger one.
                 -> src/trigger/video.ts:176 machine: "medium-1x"
                 -> src/trigger/video.ts:332 machine: "large-1x"
  [NA          ] Schedules are registered per tenant at runtime
  [NA          ] Higher-priority work is served first
  [FAIL        ] One tenant's volume does not delay another's
                 A queue limit alone is global: whoever enqueues first holds the slots, so one tenant submitting hundreds of items delays everyone behind them. A per-tenant concurrency key partitions the same limit so tenants progress independently.
  [PASS        ] Replaying the parent does not duplicate work
  [NA          ] Fan-out is split to fit the batch size cap
  [PASS        ] Large content is passed by reference, not in the payload
  [NA          ] Progress reporting stays inside the metadata size cap
  [PASS        ] Aggregated results stay inside the output size cap
  [FAIL        ] Idempotency keys are scoped to survive a replay
                 These keys are run-scoped, which is the default for a raw string and narrower than it appears: the key is hashed together with the parent's run id. That covers a retried attempt of the same parent, but a replay is a new run with a new id, so every key changes and every child is dispatched again — the duplication the task rules out, in the case most likely to happen, since replaying a partially-failed parent is the normal way to recover one. Creating the key with global scope ties it to the item instead of the run.
                 -> src/trigger/video.ts:162 raw string key (run scope by default)
                 -> src/trigger/video.ts:167 raw string key (run scope by default)
  
  Score 0.7 (14 passed, 6 failed, 9 n/a)
  ```
