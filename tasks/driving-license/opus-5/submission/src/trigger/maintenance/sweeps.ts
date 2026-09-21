import { logger, schedules } from "@trigger.dev/sdk";
import { store } from "../../lib/store";
import { addDays, istDateKey, jitterSeconds } from "../../lib/time";
import { cancelApplication } from "../applications/cancel";
import { dispatchNotification } from "../notifications/dispatch";
import { pushToNationalRegister } from "../sync/national-register";
import { refundPayment } from "../payments/refund";
import { bulkQueue, PRIORITY, TTL } from "../queues";

/**
 * Housekeeping.
 *
 * Every one of these runs on the small bulk queue. That is the whole point:
 * they are allowed to be slow, and they must never be able to take capacity
 * away from somebody waiting at an RTO counter. Where a sweep fans out, it
 * fans out onto queues that are themselves capped, and it spreads the work
 * over a window instead of firing it all at once.
 */

/** Unconfirmed seat holds, released so the inventory does not silently drain. */
export const releaseExpiredHolds = schedules.task({
  id: "maintenance.release-expired-holds",
  cron: { pattern: "*/5 * * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 120,
  retry: { maxAttempts: 2 },
  run: async () => {
    const expired = await store.listExpiredHolds(new Date().toISOString());
    let released = 0;
    for (const hold of expired) {
      if (await store.releaseHold(hold.id)) released += 1;
    }
    if (released > 0) logger.info("Released expired slot holds", { released });
    return { released };
  },
});

/**
 * Applications abandoned mid-flow. Thirty days is the statutory shelf life of
 * an unpaid application; anything paid but stalled is refunded rather than
 * left to rot, because the citizen is owed either a licence or their money.
 */
export const expireStaleApplications = schedules.task({
  id: "maintenance.expire-stale-applications",
  cron: { pattern: "15 1 * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 900,
  retry: { maxAttempts: 2 },
  run: async (payload) => {
    const cutoff = addDays(payload.timestamp, -30).toISOString();
    const stale = await store.listApplicationsOlderThan(cutoff, [
      "SUBMITTED",
      "KYC_PENDING",
      "DOCS_PENDING",
      "DOCS_REJECTED",
      "FEE_PENDING",
      "SLOT_PENDING",
      "TEST_FAILED",
    ]);
    if (stale.length === 0) return { expired: 0 };

    await cancelApplication.batchTrigger(
      stale.map((application) => ({
        payload: {
          applicationId: application.id,
          citizenId: application.applicant.citizenId,
          reason: "No activity for 30 days",
          refundReason: "APPLICATION_CANCELLED" as const,
          finalStatus: "EXPIRED" as const,
        },
        options: {
          concurrencyKey: application.applicant.citizenId,
          priority: PRIORITY.BACKGROUND,
          ttl: TTL.BACKGROUND,
          // Spread over an hour: thousands of expiries must not become
          // thousands of simultaneous refunds against the gateway.
          delay: `${jitterSeconds(application.id, 3_600)}s`,
          tags: [`application:${application.id}`],
        },
      })),
    );

    logger.info("Expired stale applications", { count: stale.length });
    return { expired: stale.length };
  },
});

/**
 * Renewal reminders at 30, 7 and 1 days. This is the single largest fan-out in
 * the system — a day's worth of national expiries — so it goes out at low
 * priority, with a jittered delay, behind the same per-citizen throttles as
 * everything else.
 */
export const licenceExpiryReminders = schedules.task({
  id: "maintenance.licence-expiry-reminders",
  cron: { pattern: "0 10 * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 900,
  retry: { maxAttempts: 2 },
  run: async (payload) => {
    let queued = 0;

    for (const leadDays of [30, 7, 1]) {
      const dateKey = istDateKey(addDays(payload.timestamp, leadDays));
      const expiring = await store.listLicencesExpiringOn(dateKey);
      if (expiring.length === 0) continue;

      const items = [];
      for (const licence of expiring) {
        const contact = await store.getContact(licence.citizenId);
        if (!contact) continue;
        items.push({
          payload: {
            citizenId: licence.citizenId,
            event: "LICENCE_EXPIRING" as const,
            mobile: contact.mobile,
            email: contact.email,
            language: contact.language,
            variables: { dlNumber: licence.number, validTill: licence.validTill },
            dedupeKey: `expiring:${licence.number}:${leadDays}`,
          },
          options: {
            concurrencyKey: licence.citizenId,
            priority: PRIORITY.BACKGROUND,
            ttl: TTL.NOTIFICATION,
            // Six hours of spread keeps the aggregator inside its TPS ceiling
            // without any coordination between runs.
            delay: `${jitterSeconds(licence.number, 6 * 3_600)}s`,
            tags: [`citizen:${licence.citizenId}`, "expiry-reminder"],
          },
        });
      }

      if (items.length > 0) {
        await dispatchNotification.batchTrigger(items);
        queued += items.length;
      }
    }

    logger.info("Queued licence expiry reminders", { queued });
    return { queued };
  },
});

/**
 * Dead-letter replay. Only the two kinds that are genuinely safe to retry
 * unattended are replayed — both are idempotent at the provider. Everything
 * else stays put for a human, which is the correct outcome for unattributed
 * money.
 */
export const replayDeadLetters = schedules.task({
  id: "maintenance.replay-dead-letters",
  cron: { pattern: "40 * * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async () => {
    let replayed = 0;

    for (const entry of await store.listDeadLetters("payment.refund", 100)) {
      const payload = entry.payload as { paymentId: string; amountPaise: number; reason: string; orphaned?: boolean };
      await refundPayment.trigger(
        {
          paymentId: payload.paymentId,
          amountPaise: payload.amountPaise,
          reason: payload.reason as never,
          orphaned: payload.orphaned ?? false,
        },
        { priority: PRIORITY.BACKGROUND, ttl: TTL.BACKGROUND, tags: [`payment:${payload.paymentId}`, "replay"] },
      );
      await store.resolveDeadLetter(entry.id);
      replayed += 1;
    }

    for (const entry of await store.listDeadLetters("sync.nr-push", 100)) {
      await pushToNationalRegister.trigger(
        { dlNumber: entry.reference },
        { priority: PRIORITY.BACKGROUND, ttl: TTL.BACKGROUND, tags: [`licence:${entry.reference}`, "replay"] },
      );
      await store.resolveDeadLetter(entry.id);
      replayed += 1;
    }

    if (replayed > 0) logger.info("Replayed dead letters", { replayed });
    return { replayed };
  },
});
