/**
 * ANTI-PATTERN: correct structure, written with v3 reflexes.
 *
 * Every primitive choice here is right. What is wrong is the vintage of the
 * API used to express it: the error hook the SDK renamed, the lifecycle hook
 * it renamed, the metadata helpers it replaced with streams and replace. This
 * is what a model trained on v3 documentation produces, and it is invisible to
 * every usage check because the shape of the solution is correct.
 *
 * Exists to prove static.no_deprecated_apis fires on the exact surfaces the
 * evidence-ingest task routes through.
 *
 * Expected to fail: no_deprecated_apis.
 */
import { metadata, queue, task } from "@trigger.dev/sdk";

export const ocrQueue = queue({
  name: "ocr",
  concurrencyLimit: 12,
});

export const ocrDocument = task({
  id: "ocr-document",
  queue: ocrQueue,
  retry: { maxAttempts: 5, minTimeoutInMs: 1000, factor: 2 },

  run: async (payload: { documentId: string }, { signal }) => {
    const response = await fetch(`https://ocr.test/${payload.documentId}`, { signal });

    // Replaced by streams.pipe.
    await metadata.stream("text", response.body!);

    // Replaced by metadata.replace.
    metadata.save({ documentId: payload.documentId, stage: "extracted" });

    return { documentId: payload.documentId, textKey: `s3://text/${payload.documentId}` };
  },

  // Renamed to onStartAttempt.
  onStart: async ({ payload }) => {
    metadata.parent.append("auditLog", `ocr:start:${payload.documentId}`);
  },

  // Renamed to catchError.
  handleError: async ({ error }) => {
    if (error instanceof Error && /unsupported|corrupt|password/.test(error.message)) {
      return { skipRetrying: true };
    }
  },

  onCancel: async () => {},
});

export const ingestCorpus = task({
  id: "ingest-corpus",
  run: async (payload: { matterId: string; documentIds: string[] }) => {
    metadata.set("total", payload.documentIds.length);

    const batch = await ocrDocument.batchTriggerAndWait(
      payload.documentIds.map((documentId) => ({ payload: { documentId } })),
    );

    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (!run.ok) failed.push(payload.documentIds[index]);
    });

    return { matterId: payload.matterId, failed: failed.length };
  },
});
