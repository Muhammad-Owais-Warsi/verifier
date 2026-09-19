/**
 * ANTI-PATTERN: written against the Trigger.dev v2/v3 mental model.
 *
 * `client.defineJob` and `io.runTask` do not exist in v4. A model that writes
 * this has memorised an older version of the framework.
 *
 * Expected to fail: static.no_v3_apis (and type checking, since these symbols
 * no longer resolve).
 */
// @ts-nocheck
import { TriggerClient } from "@trigger.dev/sdk";

const client = new TriggerClient({ id: "products" });

client.defineJob({
  id: "process-products-workflow",
  name: "Process products",
  version: "1.0.0",
  run: async (payload: { productIds: string[] }, io) => {
    const successful: string[] = [];

    for (const productId of payload.productIds) {
      await io.runTask(`process-${productId}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      successful.push(productId);
    }

    return { successful, failed: [] };
  },
});
