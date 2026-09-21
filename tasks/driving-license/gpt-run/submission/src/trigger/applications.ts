import { task } from "@trigger.dev/sdk/v3";
import type { ApplicationEvent } from "./contracts";
import { deliverNotification } from "./notifications";
import { api, withAdmission } from "./platform";
import { syncApplicationToState } from "./sync";

export const processApplicationEvent = task({
  id: "process-application-event",
  queue: { concurrencyLimit: 150 },
  retry: {
    maxAttempts: 8,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
    randomize: true,
  },
  run: async (event: ApplicationEvent) =>
    withAdmission("application", event.userId, async () => {
      const transition = await api<{ changed: boolean; currentVersion: number }>(
        `/v1/applications/${encodeURIComponent(event.applicationId)}/events`,
        {
          method: "POST",
          idempotencyKey: event.eventId,
          body: event,
        },
      );

      // The database transition rejects stale versions and invalid state changes.
      // Only the winner emits side effects, so redelivery remains harmless.
      if (!transition.changed) {
        return { changed: false, version: transition.currentVersion };
      }

      const syncId = `${event.applicationId}:${transition.currentVersion}`;
      await Promise.all([
        syncApplicationToState.trigger(
          {
            syncId,
            applicationId: event.applicationId,
            userId: event.userId,
            stateCode: event.stateCode,
            expectedVersion: transition.currentVersion,
          },
          {
            idempotencyKey: `sync:${syncId}`,
            tags: [`user:${event.userId}`, `application:${event.applicationId}`],
          },
        ),
        deliverNotification.trigger(
          {
            notificationId: `application:${event.eventId}`,
            userId: event.userId,
            applicationId: event.applicationId,
            template:
              event.status === "LICENSE_ISSUED"
                ? "LICENSE_ISSUED"
                : "APPLICATION_UPDATE",
            channels: ["email", "sms"],
            variables: {
              applicationId: event.applicationId,
              status: event.status,
            },
          },
          {
            idempotencyKey: `application-notification:${event.eventId}`,
            tags: [`user:${event.userId}`, `application:${event.applicationId}`],
          },
        ),
      ]);

      return { changed: true, version: transition.currentVersion };
    }),
});

export const submitApplication = task({
  id: "submit-application",
  queue: { concurrencyLimit: 75 },
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
  },
  run: async (payload: {
    requestId: string;
    applicationId: string;
    userId: string;
  }) =>
    withAdmission("submission", payload.userId, async () => {
      const validation = await api<{ valid: boolean; errors: string[] }>(
        `/v1/applications/${encodeURIComponent(payload.applicationId)}/validate`,
        {
          method: "POST",
          idempotencyKey: `validate:${payload.requestId}`,
          body: { userId: payload.userId },
        },
      );
      if (!validation.valid) return { submitted: false, errors: validation.errors };

      return api<{ submitted: boolean; version: number }>(
        `/v1/applications/${encodeURIComponent(payload.applicationId)}/submit`,
        {
          method: "POST",
          idempotencyKey: payload.requestId,
          body: { userId: payload.userId },
        },
      );
    }),
});
