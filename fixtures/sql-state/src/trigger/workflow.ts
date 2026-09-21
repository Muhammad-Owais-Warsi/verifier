/**
 * Correct submission that keeps its domain state in SQL.
 *
 * A status column, updates that move an application through its states, and
 * counting rows for a summary are all ordinary persistence. The scheduler
 * check must not fire on any of it -- only on SQL that hands work out to
 * workers -- or every application with a database would be marked down.
 *
 * Must pass no_external_orchestrator.
 */
import { metadata, queue, task } from "@trigger.dev/sdk";

/** Stands in for a database driver; the SQL text is what matters here. */
async function query<T = unknown>(
  _sql: string,
  _params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  return { rows: [], rowCount: 0 };
}

const applicationQueue = queue({ name: "applications", concurrencyLimit: 8 });

const retry = { maxAttempts: 5, minTimeoutInMs: 1_000 };

export const reviewApplication = task({
  id: "review-application",
  queue: applicationQueue,
  retry,
  run: async (payload: { applicationId: string; citizenId: string }) => {
    await query("update applications set status = 'under_review' where id = $1", [
      payload.applicationId,
    ]);

    const pending = await query<{ count: string }>(
      "select count(*) from applications where status = 'pending'",
    );
    metadata.set("pendingApplications", Number(pending.rows[0].count));

    const history = await query(
      "select id, status from application_events where application_id = $1 order by created_at",
      [payload.applicationId],
    );

    await query("update applications set status = 'approved' where id = $1", [
      payload.applicationId,
    ]);

    return { applicationId: payload.applicationId, events: history.rowCount };
  },
});
