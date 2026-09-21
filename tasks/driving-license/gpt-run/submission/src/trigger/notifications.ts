import { logger, task } from "@trigger.dev/sdk/v3";
import type { NotificationRequest } from "./contracts";
import { api, isPermanent, withAdmission } from "./platform";

type DeliveryResult = {
  accepted: boolean;
  providerMessageId?: string;
  reason?: string;
};

export const deliverNotification = task({
  id: "deliver-notification",
  queue: { concurrencyLimit: 200 },
  retry: {
    maxAttempts: 8,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 300_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: NotificationRequest) =>
    withAdmission("notification", payload.userId, async () => {
      const profile = await api<{
        email?: string;
        mobile?: string;
        emailOptIn: boolean;
        smsOptIn: boolean;
      }>(`/v1/users/${encodeURIComponent(payload.userId)}/notification-profile`);

      const results: Record<string, DeliveryResult> = {};
      for (const channel of [...new Set(payload.channels)]) {
        const destination =
          channel === "email" ? profile.email : profile.mobile;
        const allowed =
          channel === "email" ? profile.emailOptIn : profile.smsOptIn;

        if (!destination || !allowed) {
          results[channel] = { accepted: false, reason: "unavailable_or_opted_out" };
          continue;
        }

        try {
          results[channel] = await api<DeliveryResult>(
            `/v1/notifications/providers/${channel}/send`,
            {
              method: "POST",
              idempotencyKey: `${payload.notificationId}:${channel}`,
              body: {
                destination,
                template: payload.template,
                locale: payload.locale ?? "en-IN",
                variables: payload.variables,
              },
            },
          );
        } catch (error) {
          if (!isPermanent(error)) throw error;
          results[channel] = { accepted: false, reason: "invalid_request" };
          logger.error("Permanent notification delivery failure", {
            notificationId: payload.notificationId,
            channel,
            error,
          });
        }
      }

      await api("/v1/notifications/delivery-results", {
        method: "POST",
        idempotencyKey: payload.notificationId,
        body: { ...payload, results },
      });
      return results;
    }),
});
