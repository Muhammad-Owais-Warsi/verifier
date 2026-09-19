/**
 * ANTI-PATTERN: the child task is not exported.
 *
 * Trigger.dev only registers exported tasks, so this one silently never exists
 * on the platform and every trigger against it fails at runtime.
 *
 * Expected to fail: static.tasks_exported.
 */
import { queue, task } from "@trigger.dev/sdk";

export const productQueue = queue({
  name: "product-processing-queue",
  concurrencyLimit: 5,
});

const processProductTask = task({
  id: "process-product",
  queue: productQueue,
  retry: { maxAttempts: 3 },
  run: async (payload: { productId: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { productId: payload.productId, status: "completed" as const };
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
