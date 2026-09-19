/**
 * ANTI-PATTERN: real child tasks, but the concurrency cap is enforced by a
 * hand-rolled semaphore instead of a Trigger.dev queue.
 *
 * Observed overlap in the baseline run is a correct 5, which is exactly why
 * recorded facts alone cannot catch this. The counterfactual run does: with
 * every queue overridden to a limit of 1, this submission keeps running 5 at a
 * time because nothing it does depends on the platform's queue.
 *
 * Expected to fail: concurrency.
 */
import { task } from "@trigger.dev/sdk";

export const processProductTask = task({
  id: "process-product",
  retry: { maxAttempts: 3 },
  run: async (payload: { productId: string }) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 2000 + 1000));
    if (Math.random() < 0.1) {
      throw new Error(`Transient failure processing product: ${payload.productId}`);
    }
    return { productId: payload.productId, status: "completed" as const };
  },
});

/** Runs at most `limit` promises at a time. This is the thing being caught. */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

export const processProductsWorkflow = task({
  id: "process-products-workflow",
  run: async (payload: { productIds: string[] }) => {
    const successful: string[] = [];
    const failed: string[] = [];

    const results = await withConcurrency(payload.productIds, 5, (productId) =>
      processProductTask.triggerAndWait({ productId }),
    );

    results.forEach((result, index) => {
      const productId = payload.productIds[index];
      if (result.status === "fulfilled" && result.value.ok) {
        successful.push(productId);
      } else {
        failed.push(productId);
      }
    });

    return { successful, failed };
  },
});
