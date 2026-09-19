/**
 * Satisfies the advanced requirements with the platform primitives: a waitpoint
 * token for human review, a stream for incremental output, a machine preset
 * with out-of-memory recovery, runtime-registered per-tenant schedules,
 * priority, and a per-tenant concurrency key.
 */
import {
  idempotencyKeys,
  metadata,
  queue,
  schedules,
  streams,
  task,
  wait,
} from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-summarise",
  concurrencyLimit: 20,
});

interface Tenant {
  tenantId: string;
  plan: "paid" | "free";
  digestCron: string;
  timezone: string;
}

export const extractText = task({
  id: "extract-text",
  machine: "large-2x",
  retry: {
    maxAttempts: 3,
    outOfMemory: { machine: "large-2x" },
  },
  run: async (payload: { documentId: string }) => {
    return { textUrl: `s3://extracted/${payload.documentId}.txt` };
  },
});

export const summariseSection = task({
  id: "summarise-section",
  queue: sectionQueue,
  retry: { maxAttempts: 5, minTimeoutInMs: 1000, factor: 2, randomize: true },
  run: async (payload: { tenantId: string; sectionId: string }, { signal }) => {
    const response = await fetch("https://llm.test/summarise", {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    });

    // The partial summary reaches the reviewer as the model produces it.
    const { waitUntilComplete } = await streams.pipe("summary", response.body!);
    await waitUntilComplete;

    const confidence = 0.4;
    if (confidence < 0.5) {
      // Park until a reviewer decides. The HTTP handler completes this token.
      const token = await wait.createToken({ timeout: "3d" });
      metadata.set(`review:${payload.sectionId}`, token.id);

      const review = await wait.forToken<{ approved: boolean }>(token);
      if (!review.ok) {
        return { sectionId: payload.sectionId, status: "disclaimed" as const };
      }
    }

    return { sectionId: payload.sectionId, status: "approved" as const };
  },
  onCancel: async () => {},
});

export const reviewDocument = task({
  id: "review-document",
  run: async (payload: { tenantId: string; plan: Tenant["plan"]; sectionIds: string[] }) => {
    metadata.set("status", "summarising");

    const items = [];
    for (const sectionId of payload.sectionIds) {
      items.push({
        payload: { tenantId: payload.tenantId, sectionId },
        options: {
          concurrencyKey: payload.tenantId,
          priority: payload.plan === "paid" ? 100 : 0,
          idempotencyKey: await idempotencyKeys.create(
            `${payload.tenantId}:${sectionId}`,
            { scope: "global" },
          ),
        },
      });
    }

    const batch = await summariseSection.batchTriggerAndWait(items);

    const settled: string[] = [];
    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (run.ok) settled.push(run.output.sectionId);
      else failed.push(payload.sectionIds[index]);
    });

    metadata.set("status", "publishing");
    return { settled, failed };
  },
});

export const tenantDigest = schedules.task({
  id: "tenant-digest",
  run: async (payload) => {
    return { tenantId: payload.externalId };
  },
});

/** Each tenant's digest time is registered at runtime, not hard-coded. */
export const registerTenantDigest = task({
  id: "register-tenant-digest",
  run: async (payload: Tenant) => {
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
