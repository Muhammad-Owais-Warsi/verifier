/**
 * Reaches for the right primitive every time and then hands each one more than
 * it accepts: one batch call for the whole fan-out, file bytes in the payload,
 * a metadata record per item, every child output returned whole, and a
 * raw-string idempotency key.
 *
 * Every usage check should pass here. Only the limit checks separate this from
 * a correct submission, which is the point.
 */
import { readFile } from "node:fs/promises";
import { idempotencyKeys, metadata, queue, schedules, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-summarise",
  concurrencyLimit: 20,
});

export const summariseSection = task({
  id: "summarise-section",
  queue: sectionQueue,
  retry: { maxAttempts: 5 },
  run: async (payload: { sectionId: string; content: string }, { signal }) => {
    await fetch("https://llm.test/summarise", {
      method: "POST",
      body: payload.content,
      signal,
    });

    return { sectionId: payload.sectionId, summary: payload.content.slice(0, 40) };
  },
  onCancel: async () => {},
});

export const reviewDocument = task({
  id: "review-document",
  run: async (payload: { tenantId: string; sectionIds: string[] }) => {
    metadata.set("status", "summarising");

    const items = [];
    for (const sectionId of payload.sectionIds) {
      // The whole section body travels in the trigger payload.
      const content = await readFile(`/tmp/${sectionId}.txt`, "utf8");

      items.push({
        payload: { sectionId, content },
        options: { idempotencyKey: `section:${sectionId}` },
      });

      // One record per item, accumulated for the life of the run.
      metadata.append("sections", { sectionId, status: "queued" });
    }

    const batch = await summariseSection.batchTriggerAndWait(items);

    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (!run.ok) failed.push(payload.sectionIds[index]);
    });

    return {
      failed,
      results: batch.runs.map((run) => (run.ok ? run.output : null)),
    };
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
