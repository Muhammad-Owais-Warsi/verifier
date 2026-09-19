/**
 * ANTI-PATTERN: the child task's run() is called directly.
 *
 * This executes the body in-process. No queue, no retries, no run record --
 * the task definition is decoration around a plain function call.
 *
 * Expected to fail: static.no_direct_run_calls.
 */
import { task } from "@trigger.dev/sdk";

export const processProductTask = task({
  id: "process-product",
  retry: { maxAttempts: 3 },
  run: async (payload: { productId: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { productId: payload.productId, status: "completed" as const };
  },
});

export const processProductsWorkflow = task({
  id: "process-products-workflow",
  run: async (payload: { productIds: string[] }) => {
    const successful: string[] = [];

    for (const productId of payload.productIds) {
      // Bypasses the platform entirely.
      const result = await processProductTask.run({ productId });
      successful.push(result.productId);
    }

    return { successful, failed: [] as string[] };
  },
});
