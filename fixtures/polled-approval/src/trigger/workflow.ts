/**
 * The shape models reach for on the advanced requirements: poll a table for the
 * reviewer's answer, publish only whole values, one hard-coded cron for every
 * tenant, a single shared queue, and no machine sizing.
 */
import { metadata, queue, schedules, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-summarise",
  concurrencyLimit: 20,
});

declare function loadReview(sectionId: string): Promise<{ approved: boolean } | null>;
declare function loadTenants(): Promise<{ tenantId: string; digestCron: string }[]>;

export const extractText = task({
  id: "extract-text",
  retry: { maxAttempts: 3 },
  run: async (payload: { documentId: string }) => {
    return { textUrl: `s3://extracted/${payload.documentId}.txt` };
  },
});

export const summariseSection = task({
  id: "summarise-section",
  queue: sectionQueue,
  retry: { maxAttempts: 5, minTimeoutInMs: 1000 },
  run: async (payload: { tenantId: string; sectionId: string }, { signal }) => {
    const response = await fetch("https://llm.test/summarise", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });

    // Only the finished text is published, so the reviewer sees nothing until
    // the whole section is done.
    const summary = await response.text();
    metadata.set(`summary:${payload.sectionId}`, summary);

    // Polls a table on a timer instead of being told when review happens.
    let review = await loadReview(payload.sectionId);
    while (!review) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      review = await loadReview(payload.sectionId);
    }

    return {
      sectionId: payload.sectionId,
      status: review.approved ? ("approved" as const) : ("rejected" as const),
    };
  },
  onCancel: async () => {},
});

export const reviewDocument = task({
  id: "review-document",
  run: async (payload: { tenantId: string; sectionIds: string[] }) => {
    metadata.set("status", "summarising");

    const batch = await summariseSection.batchTriggerAndWait(
      payload.sectionIds.map((sectionId) => ({
        payload: { tenantId: payload.tenantId, sectionId },
        options: { idempotencyKey: `${payload.tenantId}:${sectionId}` },
      })),
    );

    const settled: string[] = [];
    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (run.ok) settled.push(run.output.sectionId);
      else failed.push(payload.sectionIds[index]);
    });

    return { settled, failed };
  },
});

/** One cron for everybody, filtering tenants in code. */
export const allTenantDigests = schedules.task({
  id: "all-tenant-digests",
  cron: "0 * * * *",
  run: async () => {
    const tenants = await loadTenants();
    const due = tenants.filter((tenant) => tenant.digestCron.startsWith("0"));
    return { sent: due.length };
  },
});
