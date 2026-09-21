/**
 * ANTI-PATTERN: the job queue is built inside Postgres.
 *
 * Nothing is imported from npm, so the old import-only check passed this. But
 * a pending/running status column, an advisory lock, `for update skip locked`
 * and a loop that claims one row at a time is a scheduler -- it decides what
 * runs next and how many run at once, which is the queue's job.
 *
 * Expected to fail: no_external_orchestrator.
 */
import { queue, task } from "@trigger.dev/sdk";

/** Stands in for a database driver; the SQL text is what matters here. */
async function query<T = unknown>(
  _sql: string,
  _params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  return { rows: [], rowCount: 0 };
}

const workerQueue = queue({ name: "workers", concurrencyLimit: 4 });

const retry = { maxAttempts: 5, minTimeoutInMs: 1_000 };

export const processJob = task({
  id: "process-job",
  queue: workerQueue,
  retry,
  run: async (payload: { jobId: string }) => {
    await query("update jobs set status = 'done' where id = $1", [payload.jobId]);
    return { jobId: payload.jobId };
  },
});

export const dispatchJobs = task({
  id: "dispatch-jobs",
  retry,
  run: async () => {
    for (;;) {
      await query("select pg_advisory_xact_lock(4711)");

      const claimed = await query<{ id: string }>(`
        update jobs set status = 'running'
        where id = (
          select id from jobs where status = 'pending'
          order by created_at limit 1
          for update skip locked
        )
        returning id
      `);

      const next = claimed.rows[0];
      if (!next) break;

      await processJob.trigger({ jobId: next.id });
    }

    return { drained: true };
  },
});
