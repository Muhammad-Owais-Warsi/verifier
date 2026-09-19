same task , same model


 It's using Trigger.dev as a plain function runner and rebuilding the platform in Postgres. Every failure is the
  same trade: a built-in feature ignored, hand-written SQL in its place.

  • Waiting for children — no triggerAndWait or batch anywhere. Each stage fires the next and forgets it, so "are
    all formats done?" is answered by counting rows.
  • Per-item results — because it never waits, it never sees which run succeeded. It reads a status column
    instead.
  • Failure isolation — same cause. There's no point in the code that says "this format failed, the others are
    fine."
  • Progress — no metadata, no realtime. Status lives only in its own tables, so nothing shows in the dashboard.
  • Fairness between users — no concurrencyKey. It wrote a round-robin order by last_dispatched_at instead, so the
    platform still sees one flat queue of 2.
  • Duplicate work on replay — no idempotency keys at all. It relies on on conflict do nothing, which protects the
    database row but doesn't stop the run from being started twice.
  • Out of memory — it does raise the machine to large-1x, but has no out-of-memory retry, so a video too big for
    that just crashes on the same machine forever.

  The clearest example is dispatchEncodes: it takes a Postgres advisory lock, counts how many encodes are running,
  stops at 2, picks the next job by least-recently-served user, and loops. That is a job scheduler — concurrency
  limits, fair queuing, work claiming — written by hand, when a queue with a concurrency limit and a concurrency key
  does all of it.



>nearly identical. Five of the failures are the same in both runs: no waiting for children, no per-run
  results, no failure isolation, no out-of-memory retry, and no per-tenant concurrency key. Both reached them the
  same way, by chaining fire-and-forget triggers and coordinating through Postgres.

>The two differences both make this run worse. On replay safety, the previous attempt at least created idempotency
  keys and hashed the video content into them — it just left them run-scoped, so they broke across users. This one
  dropped keys entirely and relies on on conflict do nothing. And the previous one published progress through
  metadata, which passed; this one keeps status only in its own tables, so that check now fails too.
