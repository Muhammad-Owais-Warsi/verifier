/**
 * Correct submission built the way a real mixed pipeline is: it fans out to
 * several *different* tasks through the standalone `batch` namespace rather
 * than through `task.batchTriggerAndWait`.
 *
 * Four patterns here were each reported as a defect:
 *   - queue limits configured from the environment instead of written as
 *     literals, which read as no limit at all;
 *   - `batch.triggerByTaskAndWait`, which was not recognised as a dispatch, so
 *     this task was not seen as the orchestrator and the result handling below
 *     was never examined;
 *   - `Promise.all` assembling the batch items (awaiting a key per item), read
 *     as in-process parallel work;
 *   - a `setTimeout` loop draining a local encoder's output, read as polling
 *     that a waitpoint should have replaced.
 *
 * Must pass everything.
 */
import { batch, idempotencyKeys, logger, metadata, queue, task } from "@trigger.dev/sdk";

const ENCODE_CONCURRENCY = Number(process.env.ENCODE_CONCURRENCY ?? 3);

export const encodingQueue = queue({
  name: "encoding",
  concurrencyLimit: ENCODE_CONCURRENCY,
});

const retry = { maxAttempts: 6, factor: 2, minTimeoutInMs: 1_000 };

export const encodeRendition = task({
  id: "encode-rendition",
  queue: encodingQueue,
  retry,
  run: async (payload: { assetId: string; specId: string }, { signal }) => {
    // Drains the encoder's output files while it runs in this process. There
    // is no waitpoint that can stand in for this: the run has to keep
    // executing for the subprocess to make progress.
    let encoding = true;
    setTimeout(() => {
      encoding = false;
    }, 50);

    const segments: string[] = [];
    while (encoding) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (signal.aborted) break;
      segments.push(`${payload.specId}-${segments.length}.ts`);
    }

    return { specId: payload.specId, segments: segments.length };
  },
  onCancel: async () => {},
});

export const generateThumbnails = task({
  id: "generate-thumbnails",
  queue: encodingQueue,
  retry,
  run: async (payload: { assetId: string }) => {
    return { posterKey: `${payload.assetId}/poster.jpg` };
  },
  onCancel: async () => {},
});

export const processAsset = task({
  id: "process-asset",
  retry,
  run: async (payload: { assetId: string; tenantId: string; specIds: string[] }) => {
    metadata.set("renditions", { total: payload.specIds.length, ready: 0 });

    // Building the items, not doing the work: each one needs a key, and
    // creating a key is asynchronous.
    const renditionItems = await Promise.all(
      payload.specIds.map(async (specId) => ({
        task: encodeRendition,
        payload: { assetId: payload.assetId, specId },
        options: {
          concurrencyKey: payload.tenantId,
          idempotencyKey: await idempotencyKeys.create(`rendition:${payload.assetId}:${specId}`, {
            scope: "global",
          }),
        },
      })),
    );

    const thumbnailItem = {
      task: generateThumbnails,
      payload: { assetId: payload.assetId },
      options: {
        concurrencyKey: payload.tenantId,
        idempotencyKey: await idempotencyKeys.create(`thumbs:${payload.assetId}`, {
          scope: "global",
        }),
      },
    };

    const fanOut = await batch.triggerByTaskAndWait([...renditionItems, thumbnailItem]);

    let ready = 0;
    const failures: string[] = [];

    for (const run of fanOut.runs) {
      if (!run.ok) {
        failures.push(run.taskIdentifier);
        continue;
      }
      ready += 1;
      metadata.set("renditions", { total: payload.specIds.length, ready });
    }

    if (failures.length > 0) {
      logger.warn("Some outputs failed; publishing the rest", { failures });
    }

    return { assetId: payload.assetId, ready, failed: failures.length };
  },
  onCancel: async () => {},
});
