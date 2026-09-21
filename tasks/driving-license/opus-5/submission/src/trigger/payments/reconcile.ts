import { logger, schedules, task } from "@trigger.dev/sdk";
import { newId } from "../../lib/ids";
import { paymentGateway } from "../../lib/providers/payment-gateway";
import { store } from "../../lib/store";
import { istDateKey, nowIso } from "../../lib/time";
import { advanceAfterFee } from "../applications/advance";
import { bulkQueue, PRIORITY, reconciliationQueue, TTL } from "../queues";
import { settlePayment } from "./settle";

/**
 * The safety net under every payment.
 *
 * Webhooks get lost, browsers get closed mid-redirect, and runs die between
 * the debit and the write. None of that may leave a citizen's money in limbo,
 * so nothing relies on the happy path having completed: the bank's end-of-day
 * settlement file is compared against our ledger every night, and any payment
 * that has been sitting in a non-terminal state for more than an hour is
 * re-read from the gateway.
 *
 * This is also the component that resumes an application whose payment landed
 * after the checkout run had already given up.
 */

export const reconcilePayment = task({
  id: "payment.reconcile-one",
  queue: reconciliationQueue,
  maxDuration: 120,
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000, randomize: true },
  run: async (payload: { paymentId: string; source: "WEBHOOK" | "SETTLEMENT" | "SWEEP" }, { signal }) => {
    const payment = await store.getPayment(payload.paymentId);
    if (!payment?.gatewayOrderId) {
      return { reconciled: false, reason: "no gateway order" };
    }

    const state = await paymentGateway.getPayment(payment.gatewayOrderId, signal);
    const outcome = await settlePayment(payment.id, state);

    logger.info("Payment reconciled", {
      paymentId: payment.id,
      source: payload.source,
      gatewayStatus: state.status,
      outcome: outcome.outcome,
    });

    if (outcome.outcome !== "PAID") {
      return { reconciled: true, outcome: outcome.outcome, reason: outcome.reason };
    }

    // The money is confirmed. If the application never got past the fee stage,
    // this is the moment it resumes — days later, without the citizen having
    // to resubmit anything.
    const application = await store.getApplication(payment.applicationId);
    if (application?.status === "FEE_PENDING") {
      await store.transitionApplication(application.id, "FEE_PAID", {
        reason: `fee confirmed by ${payload.source.toLowerCase()} reconciliation`,
        patch: { paymentId: payment.id },
      });
      await advanceAfterFee.trigger(
        { applicationId: application.id, citizenId: payment.citizenId },
        {
          concurrencyKey: payment.citizenId,
          priority: PRIORITY.STANDARD,
          ttl: TTL.BACKGROUND,
          tags: [`application:${application.id}`],
        },
      );
      return { reconciled: true, outcome: "PAID", resumedApplication: true };
    }

    return { reconciled: true, outcome: "PAID", resumedApplication: false };
  },
});

export const reconcileSettlementFile = schedules.task({
  id: "payment.reconcile-settlement",
  // After the banking day closes and the aggregator has published the file.
  cron: { pattern: "30 2 * * *", timezone: "Asia/Kolkata" },
  queue: reconciliationQueue,
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 60_000, maxTimeoutInMs: 600_000, randomize: true },
  run: async (payload) => {
    const settlementDate = istDateKey(new Date(payload.timestamp.getTime() - 86_400_000));
    let cursor: string | undefined;
    let rows = 0;
    let mismatches = 0;
    let orphans = 0;

    do {
      const page = await paymentGateway.fetchSettlement(settlementDate, cursor);
      for (const row of page.rows) {
        rows += 1;
        const payment = await store.findPaymentByOrderId(row.orderId);

        if (!payment) {
          // The bank settled money against an order we have no record of.
          // Never auto-refund this: it may belong to another environment.
          orphans += 1;
          await store.recordDeadLetter({
            id: newId("dlq"),
            kind: "payment.unattributed-settlement",
            reference: row.orderId,
            payload: row,
            error: "Settled amount could not be matched to a local payment",
            attempts: 1,
            createdAt: nowIso(),
          });
          continue;
        }

        const agrees =
          (row.status === "CAPTURED" && payment.status === "CAPTURED") ||
          (row.status === "REFUNDED" && payment.status === "REFUNDED") ||
          (row.status === "FAILED" && (payment.status === "FAILED" || payment.status === "EXPIRED"));

        if (agrees) continue;

        mismatches += 1;
        await reconcilePayment.trigger(
          { paymentId: payment.id, source: "SETTLEMENT" },
          { priority: PRIORITY.BACKGROUND, ttl: TTL.BACKGROUND, tags: [`payment:${payment.id}`] },
        );
      }
      cursor = page.nextCursor;
    } while (cursor);

    logger.info("Settlement file reconciled", { settlementDate, rows, mismatches, orphans });
    return { settlementDate, rows, mismatches, orphans };
  },
});

/**
 * Hourly sweep for payments that never reached a terminal state. Cheap, and
 * the reason a lost webhook costs a citizen an hour rather than a day.
 */
export const sweepStuckPayments = schedules.task({
  id: "payment.sweep-stuck",
  cron: { pattern: "7 * * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async () => {
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    const stuck = await store.listPaymentsByStatus(
      ["CREATED", "AUTHORIZED", "PENDING_RECONCILIATION", "REFUND_PENDING"],
      cutoff,
    );
    if (stuck.length === 0) return { swept: 0 };

    await reconcilePayment.batchTrigger(
      stuck.map((payment) => ({
        payload: { paymentId: payment.id, source: "SWEEP" as const },
        options: { priority: PRIORITY.BACKGROUND, ttl: TTL.BACKGROUND, tags: [`payment:${payment.id}`] },
      })),
    );

    logger.info("Swept stuck payments", { count: stuck.length });
    return { swept: stuck.length };
  },
});
