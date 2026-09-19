/**
 * ANTI-PATTERN: retries are done with a loop inside the task body instead of
 * the platform's retry engine.
 *
 * The workflow still recovers from transient failures, so the output looks
 * correct. But every run records attemptCount === 1, because the platform only
 * ever saw one attempt that happened to take longer. The backoff, the attempt
 * history, and the per-attempt observability are all lost.
 *
 * Expected to fail: retries.
 */
import { queue, task } from "@trigger.dev/sdk";

export const productQueue = queue({
  name: "product-processing-queue",
  concurrencyLimit: 5,
});

async function doWork(productId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 2000 + 1000));
  if (Math.random() < 0.1) {
    throw new Error(`Transient failure processing product: ${productId}`);
  }
}

export const processProductTask = task({
  id: "process-product",
  queue: productQueue,
  run: async (payload: { productId: string }) => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await doWork(payload.productId);
        return { productId: payload.productId, status: "completed" as const };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    throw lastError;
  },
});

export const processProductsWorkflow = task({
  id: "process-products-workflow",
  run: async (payload: { productIds: string[] }) => {
    const batch = await processProductTask.batchTriggerAndWait(
      payload.productIds.map((productId) => ({ payload: { productId } })),
    );

    const successful: string[] = [];
    const failed: string[] = [];

    batch.runs.forEach((run, index) => {
      if (run.ok) successful.push(payload.productIds[index]);
      else failed.push(payload.productIds[index]);
    });

    return { successful, failed };
  },
});
