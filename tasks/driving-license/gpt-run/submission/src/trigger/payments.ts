import { logger, schedules, task } from "@trigger.dev/sdk/v3";
import type { PaymentEvent } from "./contracts";
import { deliverNotification } from "./notifications";
import { api, withAdmission } from "./platform";

type ProviderPayment = {
  providerReference: string;
  amountPaise: number;
  currency: "INR";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";
  settledAt?: string;
};

export const processPaymentEvent = task({
  id: "process-payment-event",
  queue: { concurrencyLimit: 100 },
  retry: {
    maxAttempts: 10,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 300_000,
    factor: 2,
    randomize: true,
  },
  run: async (event: PaymentEvent) =>
    withAdmission("payment", event.userId, async () => {
      if (event.amountPaise <= 0 || !Number.isSafeInteger(event.amountPaise)) {
        throw new Error("Payment amount must be a positive integer in paise");
      }

      const provider = await api<ProviderPayment>(
        `/v1/payment-providers/${encodeURIComponent(event.provider)}/payments/${encodeURIComponent(event.providerReference)}`,
      );
      if (
        provider.providerReference !== event.providerReference ||
        provider.amountPaise !== event.amountPaise ||
        provider.currency !== "INR"
      ) {
        await api("/v1/payments/security-review", {
          method: "POST",
          idempotencyKey: event.eventId,
          body: { event, provider },
        });
        logger.error("Payment verification mismatch", {
          paymentId: event.paymentId,
          providerReference: event.providerReference,
        });
        return { accepted: false, reason: "verification_mismatch" };
      }

      const transition = await api<{
        changed: boolean;
        status: ProviderPayment["status"];
      }>(`/v1/payments/${encodeURIComponent(event.paymentId)}/transition`, {
        method: "POST",
        idempotencyKey: event.eventId,
        body: {
          status: provider.status,
          providerReference: provider.providerReference,
          occurredAt: event.occurredAt,
          settledAt: provider.settledAt,
        },
      });

      if (transition.changed && ["SUCCEEDED", "FAILED"].includes(transition.status)) {
        await deliverNotification.trigger(
          {
            notificationId: `payment:${event.paymentId}:${transition.status}`,
            userId: event.userId,
            applicationId: event.applicationId,
            template:
              transition.status === "SUCCEEDED"
                ? "PAYMENT_RECEIPT"
                : "PAYMENT_FAILED",
            channels: ["email", "sms"],
            variables: {
              applicationId: event.applicationId,
              paymentId: event.paymentId,
              amount: (event.amountPaise / 100).toFixed(2),
            },
          },
          {
            idempotencyKey: `payment-notification:${event.paymentId}:${transition.status}`,
            tags: [`user:${event.userId}`, `application:${event.applicationId}`],
          },
        );
      }
      return { accepted: true, ...transition };
    }),
});

export const reconcilePayments = schedules.task({
  id: "reconcile-payments",
  cron: "*/5 * * * *",
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const pending = await api<PaymentEvent[]>(
      "/v1/payments/reconciliation-candidates?limit=500",
    );
    for (const event of pending) {
      await processPaymentEvent.trigger(event, {
        idempotencyKey: `reconcile:${event.paymentId}:${event.eventId}`,
        tags: [`user:${event.userId}`, `application:${event.applicationId}`],
      });
    }
    return { enqueued: pending.length };
  },
});
