import { logger, schedules, task } from "@trigger.dev/sdk/v3";
import type { SyncRequest } from "./contracts";
import { api, withAdmission } from "./platform";

export const syncApplicationToState = task({
  id: "sync-application-to-state",
  queue: { concurrencyLimit: 100 },
  retry: {
    maxAttempts: 12,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 600_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: SyncRequest) =>
    withAdmission(`state-sync:${payload.stateCode}`, payload.userId, async () => {
      const snapshot = await api<unknown>(
        `/v1/applications/${encodeURIComponent(payload.applicationId)}/sync-snapshot`,
      );
      const result = await api<{ remoteVersion: number; conflict: boolean }>(
        `/v1/state-gateways/${encodeURIComponent(payload.stateCode)}/applications`,
        {
          method: "PUT",
          idempotencyKey: `${payload.applicationId}:${payload.expectedVersion}`,
          body: snapshot,
        },
      );

      if (result.conflict) {
        await api("/v1/sync-conflicts", {
          method: "POST",
          idempotencyKey: payload.syncId,
          body: { ...payload, remoteVersion: result.remoteVersion },
        });
        logger.warn("Application sync conflict recorded", payload);
      } else {
        await api(`/v1/applications/${payload.applicationId}/sync-complete`, {
          method: "POST",
          idempotencyKey: payload.syncId,
          body: { version: result.remoteVersion },
        });
      }
      return result;
    }),
});

export const repairOutOfSyncApplications = schedules.task({
  id: "repair-out-of-sync-applications",
  cron: "*/10 * * * *",
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const records = await api<SyncRequest[]>("/v1/sync/out-of-date?limit=500");
    const handles = [];
    for (const record of records) {
      handles.push(
        await syncApplicationToState.trigger(record, {
          idempotencyKey: record.syncId,
          tags: [`application:${record.applicationId}`, `state:${record.stateCode}`],
        }),
      );
    }
    return { enqueued: handles.length };
  },
});
