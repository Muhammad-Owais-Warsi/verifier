/**
 * Three levels: a thin router that forwards one run, the real orchestrator a
 * level deeper, and the per-item workers. Picking the top-level task as the
 * orchestrator made every fan-out check inspect the router, which correctly
 * does not batch and correctly does not wait.
 */
import { metadata, queue, streams, task } from "@trigger.dev/sdk";

export const sectionQueue = queue({
  name: "section-summarise",
  concurrencyLimit: 10,
});

export const summaryStream = streams.define<{ delta: string }>({
  id: "section-summary",
});

export const summariseSection = task({
  id: "summarise-section",
  queue: sectionQueue,
  retry: { maxAttempts: 4, minTimeoutInMs: 1000 },
  run: async (payload: { documentId: string; sectionId: string }) => {
    await summaryStream.append({ delta: "partial..." });
    return { sectionId: payload.sectionId };
  },
  onCancel: async () => {},
});

/** The real orchestrator: fans out, waits, and reads each run's outcome. */
export const processDocument = task({
  id: "process-document",
  run: async (payload: { documentId: string; sectionIds: string[] }) => {
    metadata.set("status", "summarising");

    const batch = await summariseSection.batchTriggerAndWait(
      payload.sectionIds.map((sectionId) => ({
        payload: { documentId: payload.documentId, sectionId },
        options: { idempotencyKey: `${payload.documentId}:${sectionId}` },
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

/** A router. Forwarding one run must not read as a failed fan-out. */
export const documentUploaded = task({
  id: "document-uploaded",
  run: async (payload: { documentId: string; sectionIds: string[] }) => {
    const handle = await processDocument.trigger(payload, {
      idempotencyKey: `document:${payload.documentId}`,
    });
    return { runId: handle.id };
  },
});
