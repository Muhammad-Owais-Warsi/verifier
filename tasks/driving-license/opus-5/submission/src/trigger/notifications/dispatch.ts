import { logger, schemaTask } from "@trigger.dev/sdk";
import type { NotificationChannel } from "../../lib/domain";
import { PermanentValidationError } from "../../lib/errors";
import { FAIR_USE, tryConsumeNotificationToken } from "../../lib/fair-use";
import { newId } from "../../lib/ids";
import type { NotificationRequest } from "../../lib/schemas";
import { notificationRequestSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { NOTIFICATION_SPECS } from "../../lib/templates";
import { isQuietHours, nextDeliveryWindow, nowIso } from "../../lib/time";
import { citizenNotificationQueue, TTL } from "../queues";
import { sendEmail, sendSms } from "./send";

/**
 * The single door every message goes through.
 *
 * Four things happen here, in this order, and the order matters:
 *
 * 1. Deduplication. The same event reaching us twice — a retried run, a
 *    replayed webhook, two sweeps overlapping — must produce one message.
 * 2. Consent. Opt-outs and the TRAI DND registry are honoured for anything
 *    that is not a legally required transactional update.
 * 3. Quiet hours. Deferrable messages are pushed to the next 09:00–21:00 IST
 *    window rather than waking somebody at 3am.
 * 4. Throttling. A burst bucket plus a hard daily cap per channel, so a citizen
 *    stuck in a retry loop receives three messages, not three hundred, and the
 *    aggregator bill stays finite.
 *
 * Only then is the work handed to the channel queues.
 */

const MAX_DEFERRALS = 3;

export type DispatchOutcome = {
  outcome: "SENT" | "DEDUPED" | "DEFERRED" | "SUPPRESSED";
  channels: NotificationChannel[];
  reason?: string;
};

export const dispatchNotification = schemaTask({
  id: "notify.dispatch",
  schema: notificationRequestSchema,
  queue: citizenNotificationQueue,
  ttl: TTL.NOTIFICATION,
  maxDuration: 60,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000, randomize: true },
  run: async (payload): Promise<DispatchOutcome> => {
    const spec = NOTIFICATION_SPECS[payload.event];

    if (spec.category === "PROMOTIONAL") {
      throw new PermanentValidationError("PROMOTIONAL_BLOCKED", "This system does not send promotional messages");
    }

    if ((await store.claimNotification(payload.dedupeKey, spec.dedupeWindowSeconds)) === "ALREADY_CLAIMED") {
      logger.info("Duplicate notification suppressed", { event: payload.event, dedupeKey: payload.dedupeKey });
      return { outcome: "DEDUPED", channels: [] };
    }

    const preferences = await store.getPreferences(payload.citizenId);
    const language = preferences.language || payload.language;
    const transactional = spec.category === "TRANSACTIONAL";

    const channels = spec.channels.filter((channel) => {
      if (channel === "SMS") return !(preferences.smsOptOut && !transactional) && !(preferences.dndRegistered && !transactional);
      if (channel === "EMAIL") return Boolean(payload.email) && !(preferences.emailOptOut && !transactional);
      return preferences.pushTokens.length > 0;
    });

    if (channels.length === 0) {
      return { outcome: "SUPPRESSED", channels: [], reason: "no consented channel" };
    }

    // Quiet hours: defer rather than drop. Re-triggering with the bypass flag
    // set means the deferred copy cannot be deferred again.
    if (!payload.bypassQuietHours && !transactional && isQuietHours()) {
      const deliverAt = nextDeliveryWindow();
      await deferNotification(payload, deliverAt, "quiet hours");
      return { outcome: "DEFERRED", channels, reason: `quiet hours until ${deliverAt.toISOString()}` };
    }

    const burst = await tryConsumeNotificationToken(payload.citizenId);
    if (!burst.allowed) {
      // Something is generating events for this citizen faster than a human
      // could act on them. Transactional messages still get through, just
      // later; anything else is dropped on the floor with a record of why.
      if (!transactional || payload.deferralCount >= MAX_DEFERRALS) {
        logger.warn("Notification throttled", {
          citizenId: payload.citizenId,
          event: payload.event,
          deferralCount: payload.deferralCount,
        });
        return { outcome: "SUPPRESSED", channels: [], reason: "per-citizen burst limit" };
      }
      const deliverAt = new Date(Date.now() + burst.retryAfterSeconds * 1_000);
      await deferNotification(payload, deliverAt, "burst limit");
      return { outcome: "DEFERRED", channels, reason: `throttled for ${burst.retryAfterSeconds}s` };
    }

    // Hard daily caps are applied per channel so exhausting the SMS allowance
    // does not silently kill the email copy of the same message.
    const dispatched: NotificationChannel[] = [];
    const notificationId = newId("ntf");

    for (const channel of channels) {
      if (channel === "SMS") {
        const quota = await store.consumeDailyQuota(payload.citizenId, "SMS_PER_CITIZEN_PER_DAY", FAIR_USE.SMS_PER_CITIZEN_PER_DAY);
        if (!quota.allowed) {
          logger.warn("Daily SMS cap reached", { citizenId: payload.citizenId, event: payload.event });
          continue;
        }
        await sendSms.trigger(
          {
            notificationId: `${notificationId}_sms`,
            citizenId: payload.citizenId,
            event: payload.event,
            language,
            variables: payload.variables,
            dedupeKey: payload.dedupeKey,
            mobile: payload.mobile,
          },
          { priority: spec.priority, ttl: TTL.NOTIFICATION, tags: [`citizen:${payload.citizenId}`, `event:${payload.event}`] },
        );
        dispatched.push("SMS");
      }

      if (channel === "EMAIL" && payload.email) {
        const quota = await store.consumeDailyQuota(payload.citizenId, "EMAIL_PER_CITIZEN_PER_DAY", FAIR_USE.EMAIL_PER_CITIZEN_PER_DAY);
        if (!quota.allowed) continue;
        await sendEmail.trigger(
          {
            notificationId: `${notificationId}_eml`,
            citizenId: payload.citizenId,
            event: payload.event,
            language,
            variables: payload.variables,
            dedupeKey: payload.dedupeKey,
            email: payload.email,
          },
          { priority: spec.priority, ttl: TTL.NOTIFICATION, tags: [`citizen:${payload.citizenId}`, `event:${payload.event}`] },
        );
        dispatched.push("EMAIL");
      }
    }

    if (dispatched.length === 0) {
      return { outcome: "SUPPRESSED", channels: [], reason: "daily cap reached on every channel" };
    }
    return { outcome: "SENT", channels: dispatched };
  },
});

async function deferNotification(payload: NotificationRequest, deliverAt: Date, reason: string): Promise<void> {
  // The dedupe claim was already taken by this run, so the deferred copy needs
  // a distinct key or it would suppress itself.
  await dispatchNotification.trigger(
    {
      ...payload,
      dedupeKey: `${payload.dedupeKey}:deferred:${payload.deferralCount + 1}`,
      deferralCount: payload.deferralCount + 1,
      bypassQuietHours: true,
    },
    {
      concurrencyKey: payload.citizenId,
      delay: deliverAt,
      ttl: TTL.NOTIFICATION,
      priority: NOTIFICATION_SPECS[payload.event].priority,
      tags: [`citizen:${payload.citizenId}`, `event:${payload.event}`, "deferred"],
    },
  );
  logger.info("Notification deferred", { event: payload.event, deliverAt: deliverAt.toISOString(), reason, at: nowIso() });
}

/**
 * The only way the rest of the codebase sends anything. Wrapping the trigger
 * guarantees the per-citizen concurrency key is never forgotten — without it
 * the fairness queue would be a single global lane.
 */
export async function notifyCitizen(request: {
  citizenId: string;
  event: NotificationRequest["event"];
  mobile: string;
  email?: string;
  language?: string;
  variables?: Record<string, string>;
  dedupeKey: string;
  bypassQuietHours?: boolean;
}): Promise<void> {
  await dispatchNotification.trigger(
    {
      citizenId: request.citizenId,
      event: request.event,
      mobile: request.mobile,
      email: request.email,
      language: request.language ?? "en",
      variables: request.variables ?? {},
      dedupeKey: request.dedupeKey,
      bypassQuietHours: request.bypassQuietHours ?? false,
    },
    {
      concurrencyKey: request.citizenId,
      priority: NOTIFICATION_SPECS[request.event].priority,
      ttl: TTL.NOTIFICATION,
      tags: [`citizen:${request.citizenId}`, `event:${request.event}`],
    },
  );
}
