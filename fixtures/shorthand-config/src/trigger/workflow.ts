/**
 * Correct submission that hoists its shared config into consts and applies it
 * with shorthand: `{ retry }` rather than `{ retry: { ... } }`.
 *
 * Reusing one retry policy across every task is better practice than inlining
 * it six times, but reading only the long form made it look like no task had a
 * retry policy at all. Also covers a key built by a helper, which the scope
 * classifier used to skip because it is not a string literal.
 *
 * Must pass everything.
 */
import { idempotencyKeys, metadata, queue, task } from "@trigger.dev/sdk";

const syncQueue = queue({
  name: "repo-sync",
  concurrencyLimit: 12,
});

/** One policy, applied to every task below. */
const retry = {
  maxAttempts: 8,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
};

/** Alias, to prove the resolver follows more than one hop. */
const queue_ = syncQueue;

/** Key construction kept in one place rather than inlined at each dispatch. */
function repositoryKey(customerId: string, repositoryId: string) {
  return idempotencyKeys.create(`${customerId}:${repositoryId}`, { scope: "global" });
}

export const syncRepository = task({
  id: "sync-repository",
  queue: queue_,
  retry,
  run: async (payload: { customerId: string; repositoryId: string }, { signal }) => {
    await fetch(`https://api.github.test/repos/${payload.repositoryId}`, { signal });
    return { repositoryId: payload.repositoryId, status: "synced" as const };
  },
  onCancel: async () => {},
});

export const syncCustomer = task({
  id: "sync-customer",
  retry,
  run: async (payload: { customerId: string; repositoryIds: string[] }) => {
    metadata.set("total", payload.repositoryIds.length);

    const items = [];
    for (const repositoryId of payload.repositoryIds) {
      items.push({
        payload: { customerId: payload.customerId, repositoryId },
        options: {
          concurrencyKey: payload.customerId,
          idempotencyKey: await repositoryKey(payload.customerId, repositoryId),
        },
      });
    }

    const batch = await syncRepository.batchTriggerAndWait(items);

    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (!run.ok) failed.push(payload.repositoryIds[index]);
    });

    metadata.set("failed", failed.length);
    return { customerId: payload.customerId, failed: failed.length };
  },
});
