/**
 * ANTI-PATTERN: the idempotency key is built by a helper that returns a plain
 * string, so it carries the default run scope.
 *
 * Structurally identical to shorthand-config, and the only difference is that
 * its helper returns a string instead of a scoped key. The scope classifier
 * used to look at syntax rather than type, so a key from a helper matched
 * neither branch and the check silently reported n/a -- meaning a submission
 * could fail the requirement and never be told.
 *
 * Expected to fail: idempotency_scope.
 */
import { metadata, queue, task } from "@trigger.dev/sdk";

const syncQueue = queue({
  name: "repo-sync",
  concurrencyLimit: 12,
});

const retry = {
  maxAttempts: 8,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
};

/** Returns a plain string, so the platform applies run scope to it. */
function repositoryKey(customerId: string, repositoryId: string): string {
  return `${customerId}:${repositoryId}`;
}

export const syncRepository = task({
  id: "sync-repository",
  queue: syncQueue,
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

    const items = payload.repositoryIds.map((repositoryId) => ({
      payload: { customerId: payload.customerId, repositoryId },
      options: {
        concurrencyKey: payload.customerId,
        idempotencyKey: repositoryKey(payload.customerId, repositoryId),
      },
    }));

    const batch = await syncRepository.batchTriggerAndWait(items);

    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (!run.ok) failed.push(payload.repositoryIds[index]);
    });

    metadata.set("failed", failed.length);
    return { customerId: payload.customerId, failed: failed.length };
  },
});
