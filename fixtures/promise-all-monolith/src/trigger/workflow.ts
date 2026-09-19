/**
 * ANTI-PATTERN: everything happens inside one task.
 *
 * The output is correct, but the platform only ever sees a single run. There
 * are no child runs to schedule, retry, or observe, so Trigger.dev is doing
 * nothing beyond hosting one long function.
 *
 * Expected to fail: decomposition, batching, fan-in, concurrency.
 */
import { task } from "@trigger.dev/sdk";

async function processProduct(productId: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 2000 + 1000));
  if (Math.random() < 0.1) {
    throw new Error(`Transient failure processing product: ${productId}`);
  }
  return productId;
}

export const processProductsWorkflow = task({
  id: "process-products-workflow",
  run: async (payload: { productIds: string[] }) => {
    const successful: string[] = [];
    const failed: string[] = [];

    const results = await Promise.allSettled(
      payload.productIds.map((productId) => processProduct(productId)),
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successful.push(payload.productIds[index]);
      } else {
        failed.push(payload.productIds[index]);
      }
    });

    return { successful, failed };
  },
});
