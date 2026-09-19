/**
 * The same workflow as limit-violations, designed around the caps: items
 * chunked to the batch limit, content passed by storage key, progress reported
 * as counters, a flat summary returned, schedules registered idempotently, and
 * globally-scoped idempotency keys.
 *
 * Proves the limit checks recognise the compliant shape rather than firing on
 * any wide fan-out.
 */
import { idempotencyKeys, metadata, queue, schedules, task } from "@trigger.dev/sdk";

/** Below the 1,000-item cap a single batch call accepts. */
const BATCH_SIZE = 500;

export const sectionQueue = queue({
  name: "section-summarise",
  concurrencyLimit: 20,
});

export const summariseSection = task({
  id: "summarise-section",
  queue: sectionQueue,
  retry: { maxAttempts: 5 },
  run: async (payload: { sectionId: string; contentKey: string }, { signal }) => {
    // The child reads the body itself, so the payload stays a reference.
    const content = await fetch(payload.contentKey, { signal }).then((r) => r.text());

    await fetch("https://llm.test/summarise", {
      method: "POST",
      body: content,
      signal,
    });

    return { sectionId: payload.sectionId, summaryKey: `s3://summaries/${payload.sectionId}` };
  },
  onCancel: async () => {},
});

export const reviewDocument = task({
  id: "review-document",
  run: async (payload: { tenantId: string; sectionIds: string[] }) => {
    metadata.set("status", "summarising");
    metadata.set("total", payload.sectionIds.length);
    metadata.set("completed", 0);

    const failed: string[] = [];
    let completed = 0;

    for (let offset = 0; offset < payload.sectionIds.length; offset += BATCH_SIZE) {
      const chunk = payload.sectionIds.slice(offset, offset + BATCH_SIZE);

      const items = [];
      for (const sectionId of chunk) {
        items.push({
          payload: { sectionId, contentKey: `s3://sections/${sectionId}.txt` },
          options: {
            idempotencyKey: await idempotencyKeys.create(
              `${payload.tenantId}:${sectionId}`,
              { scope: "global" },
            ),
          },
        });
      }

      const batch = await summariseSection.batchTriggerAndWait(items);

      batch.runs.forEach((run, index) => {
        if (run.ok) completed++;
        else failed.push(chunk[index]);
      });

      // Counters stay the same size whatever the item count.
      metadata.set("completed", completed);
    }

    return { completed, failed: failed.length, firstFailures: failed.slice(0, 20) };
  },
});

export const tenantDigest = schedules.task({
  id: "tenant-digest",
  run: async (payload) => {
    return { tenantId: payload.externalId };
  },
});

export const registerTenantDigest = task({
  id: "register-tenant-digest",
  run: async (payload: { tenantId: string; digestCron: string; timezone: string }) => {
    await schedules.create({
      task: tenantDigest.id,
      cron: payload.digestCron,
      timezone: payload.timezone,
      externalId: payload.tenantId,
      deduplicationKey: `digest:${payload.tenantId}`,
    });

    return { registered: payload.tenantId };
  },
});
