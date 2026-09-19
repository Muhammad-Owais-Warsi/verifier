import { task, queue } from "@trigger.dev/sdk";

// Define a dedicated queue with a concurrency limit of 5
export const productQueue = queue({
  name: "product-processing-queue",
  concurrencyLimit: 5,
});

export interface ProcessProductPayload {
  productId: string;
}

export interface ProcessProductResult {
  productId: string;
  status: "completed";
}

/**
 * Child task: Processes an individual product independently.
 * - Concurrency capped at 5 via Trigger.dev queue.
 * - Simulates 1–3s execution duration.
 * - Simulates 10% transient failures.
 * - Automatic retry on transient failures.
 */
export const processProductTask = task({
  id: "process-product",
  queue: productQueue,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 5000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: ProcessProductPayload): Promise<ProcessProductResult> => {
    const { productId } = payload;

    // Simulate product operation duration: random 1–3 seconds
    const durationMs = Math.floor(Math.random() * 2000) + 1000;
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    // 10% transient failure rate
    if (Math.random() < 0.1) {
      throw new Error(`Transient failure processing product: ${productId}`);
    }

    return {
      productId,
      status: "completed",
    };
  },
});

export type WorkflowInput = { productIds: string[] } | string[];

export interface WorkflowSummary {
  successful: string[];
  failed: string[];
}

/**
 * Parent workflow task:
 * - Receives a list of product IDs (e.g. 100 products).
 * - Triggers all product tasks in batch.
 * - Waits for every product to either succeed or permanently fail.
 * - Returns a final summary of successful and failed product IDs.
 */
export const processProductsWorkflow = task({
  id: "process-products-workflow",
  run: async (payload: WorkflowInput): Promise<WorkflowSummary> => {
    const productIds = Array.isArray(payload) ? payload : payload.productIds;

    // Trigger all products in a batch and wait until all reach a terminal state
    const batchResult = await processProductTask.batchTriggerAndWait(
      productIds.map((productId) => ({
        payload: { productId },
      }))
    );

    const runs = Array.isArray(batchResult) ? batchResult : batchResult.runs;
    const successful: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const productId = productIds[i];

      if (run.ok) {
        successful.push(productId);
      } else {
        failed.push(productId);
      }
    }

    return {
      successful,
      failed,
    };
  },
});

export const workflow = processProductsWorkflow;
export default processProductsWorkflow;
