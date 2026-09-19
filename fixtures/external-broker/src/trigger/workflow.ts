/**
 * ANTI-PATTERN: correct Trigger.dev tasks, with the queueing and the
 * concurrency cap handed to a second broker running alongside the platform.
 *
 * This is the shape a model produces when it treats Trigger.dev as a way to
 * run functions and reaches for familiar infrastructure for everything else.
 * It works, which is the problem: the cap is real and enforced, but half the
 * pipeline's state lives somewhere the run records know nothing about.
 *
 * Expected to fail: no_external_orchestrator, concurrency.
 */
import { Queue, Worker } from "bullmq";
import { metadata, task } from "@trigger.dev/sdk";

const connection = { host: "127.0.0.1", port: 6379 };

/** The concurrency cap, owned by Redis instead of by the platform. */
const ocrQueue = new Queue<{ documentId: string }>("ocr", { connection });

new Worker<{ documentId: string }>(
  "ocr",
  async (job) => ocrDocument.triggerAndWait({ documentId: job.data.documentId }),
  { connection, concurrency: 12 },
);

export const ocrDocument = task({
  id: "ocr-document",
  retry: { maxAttempts: 3 },
  run: async (payload: { documentId: string }) => {
    return { documentId: payload.documentId, textKey: `s3://text/${payload.documentId}` };
  },
});

export const ingestCorpus = task({
  id: "ingest-corpus",
  run: async (payload: { matterId: string; documentIds: string[] }) => {
    metadata.set("total", payload.documentIds.length);

    for (const documentId of payload.documentIds) {
      await ocrQueue.add(
        "ocr",
        { documentId },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
      );
    }

    return { matterId: payload.matterId, enqueued: payload.documentIds.length };
  },
});
