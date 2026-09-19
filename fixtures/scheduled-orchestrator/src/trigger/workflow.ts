/**
 * Correct, but the orchestrator is declared with `schedules.task(...)` rather
 * than `task(...)`, the abort signal arrives destructured from the run context,
 * and the trigger options are assembled in a loop before the batch dispatch.
 * Each of those hid a satisfied requirement from the checks.
 */
import { idempotencyKeys, metadata, queue, schedules, task } from "@trigger.dev/sdk";

export const perItemQueue = queue({
  name: "per-item",
  concurrencyLimit: 1,
});

interface ItemPayload {
  itemId: string;
  version: string;
}

export const syncItem = task({
  id: "sync-item",
  queue: perItemQueue,
  retry: { maxAttempts: 5, minTimeoutInMs: 1000, factor: 2 },
  run: async (payload: ItemPayload, { signal }) => {
    const response = await fetch(`https://example.test/items/${payload.itemId}`, {
      method: "POST",
      signal,
    });
    if (!response.ok) throw new Error(`failed: ${response.status}`);
    return { itemId: payload.itemId, status: "synced" as const };
  },
});

export const syncAllItems = schedules.task({
  id: "sync-all-items",
  cron: "*/5 * * * *",
  run: async (_payload, { signal }) => {
    metadata.set("status", "discovering");

    const response = await fetch("https://example.test/items", { signal });
    const items = (await response.json()) as ItemPayload[];

    metadata.set("discovered", items.length);

    const batchItems = [];
    for (const item of items) {
      const idempotencyKey = await idempotencyKeys.create(
        `sync:${item.itemId}:${item.version}`,
        { scope: "global" },
      );

      batchItems.push({
        payload: item,
        options: { concurrencyKey: item.itemId, idempotencyKey },
      });
    }

    const batch = await syncItem.batchTriggerAndWait(batchItems);

    const synced: string[] = [];
    const failed: string[] = [];

    batch.runs.forEach((run, index) => {
      if (run.ok) synced.push(run.output.itemId);
      else failed.push(items[index].itemId);
    });

    metadata.set("status", "done");
    return { synced, failed };
  },
});
