import { logger, task } from "@trigger.dev/sdk";
import type { NotificationChannel, NotificationEvent } from "../../lib/domain";
import { maskEmail, maskMobile, newId } from "../../lib/ids";
import { emailProvider } from "../../lib/providers/email";
import { smsProvider } from "../../lib/providers/sms";
import { store } from "../../lib/store";
import { NOTIFICATION_SPECS, orderVariables, resolveTemplateId } from "../../lib/templates";
import { nowIso } from "../../lib/time";
import { emailQueue, smsQueue, TTL } from "../queues";

/**
 * Channel workers. These sit on capacity queues sized to the provider's
 * contracted throughput and are deliberately dumb: every decision about
 * *whether* to send has already been made by `notify.dispatch`. Splitting it
 * this way means a provider outage backs up in one queue instead of holding
 * open the per-citizen fairness slots.
 */

type ChannelPayload = {
  notificationId: string;
  citizenId: string;
  event: NotificationEvent;
  language: string;
  variables: Record<string, string>;
  dedupeKey: string;
};

export type SmsPayload = ChannelPayload & { mobile: string };
export type EmailPayload = ChannelPayload & { email: string };

async function recordAttempt(payload: ChannelPayload, channel: NotificationChannel): Promise<void> {
  await store.recordNotification({
    id: payload.notificationId,
    citizenId: payload.citizenId,
    event: payload.event,
    channel,
    status: "QUEUED",
    dedupeKey: payload.dedupeKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export const sendSms = task({
  id: "notify.sms",
  queue: smsQueue,
  ttl: TTL.NOTIFICATION,
  maxDuration: 60,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (payload: SmsPayload, { signal }) => {
    const spec = NOTIFICATION_SPECS[payload.event];
    await recordAttempt(payload, "SMS");

    const result = await smsProvider.send(
      {
        mobile: payload.mobile,
        dltTemplateId: resolveTemplateId(spec, payload.language),
        senderId: spec.senderId,
        variables: orderVariables(spec, payload.variables),
        transactional: spec.category === "TRANSACTIONAL",
        // Doubles as the provider-side idempotency key, so a retry after a
        // timeout cannot deliver the same SMS twice.
        clientReference: payload.notificationId,
      },
      { signal },
    );

    await store.updateNotification(payload.notificationId, {
      status: result.accepted ? "SENT" : "FAILED",
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      failureReason: result.rejectionCode,
    });

    logger.info("SMS handed to aggregator", {
      event: payload.event,
      provider: result.provider,
      to: maskMobile(payload.mobile),
    });
    return { accepted: result.accepted, provider: result.provider };
  },
  onFailure: async ({ payload }) => {
    await store.updateNotification(payload.notificationId, { status: "FAILED" });
    await store.recordDeadLetter({
      id: newId("dlq"),
      kind: "notify.sms",
      reference: payload.notificationId,
      payload,
      error: "SMS delivery exhausted all attempts",
      attempts: 4,
      createdAt: nowIso(),
    });
  },
});

export const sendEmail = task({
  id: "notify.email",
  queue: emailQueue,
  ttl: TTL.NOTIFICATION,
  maxDuration: 60,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload: EmailPayload, { signal }) => {
    const spec = NOTIFICATION_SPECS[payload.event];
    await recordAttempt(payload, "EMAIL");

    const result = await emailProvider.send(
      {
        to: payload.email,
        templateKey: spec.emailTemplateKey,
        language: payload.language,
        variables: payload.variables,
        clientReference: payload.notificationId,
      },
      signal,
    );

    await store.updateNotification(payload.notificationId, {
      status: result.suppressed ? "SUPPRESSED" : "SENT",
      provider: result.provider,
      providerMessageId: result.providerMessageId,
    });

    logger.info("Email handed to provider", { event: payload.event, to: maskEmail(payload.email) });
    return { suppressed: result.suppressed };
  },
  onFailure: async ({ payload }) => {
    await store.updateNotification(payload.notificationId, { status: "FAILED" });
  },
});

/**
 * Operator delivery receipts. Fired by the aggregator's callback endpoint; the
 * only thing it does is close the loop on the ledger, so it is cheap and never
 * retried aggressively.
 */
export const recordDeliveryReceipt = task({
  id: "notify.delivery-receipt",
  queue: smsQueue,
  maxDuration: 30,
  retry: { maxAttempts: 2 },
  run: async (payload: { notificationId: string; delivered: boolean; failureReason?: string }) => {
    await store.updateNotification(payload.notificationId, {
      status: payload.delivered ? "DELIVERED" : "FAILED",
      failureReason: payload.failureReason,
    });
    return { recorded: true };
  },
});
