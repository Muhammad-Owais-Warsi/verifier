import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { PermanentValidationError } from "../../lib/errors";
import { requireDailyQuota } from "../../lib/fair-use";
import { formatRupees, quoteFee } from "../../lib/fees";
import { newId, stableKey } from "../../lib/ids";
import type { GatewayEvent } from "../../lib/schemas";
import { collectFeeSchema } from "../../lib/schemas";
import { paymentGateway } from "../../lib/providers/payment-gateway";
import { store } from "../../lib/store";
import { notifyCitizen } from "../notifications/dispatch";
import { applicationPaymentQueue, PRIORITY, TTL } from "../queues";
import { pollPaymentStatus, POLL_TRIGGER_OPTIONS } from "./poll";
import type { SettlementOutcome } from "./settle";
import { settlePayment } from "./settle";

/**
 * Fee collection.
 *
 * The shape of this task is driven by one fact: the citizen's browser, our
 * run, and the gateway's webhook are three independent actors and any of them
 * can vanish at any point. So:
 *
 *  - The run creates a waitpoint *before* creating the order, and hands the
 *    waitpoint URL to the gateway as its callback. The webhook then completes
 *    the waitpoint and this run resumes within milliseconds of the payment,
 *    without holding a worker for the twenty minutes the citizen spends typing
 *    an OTP.
 *  - If the callback never arrives, the waitpoint times out and we fall back to
 *    polling. A timeout is never treated as a failure.
 *  - Whatever path we resume by, the decision is made from a fresh read of the
 *    gateway. The webhook body is a wake-up signal, not evidence.
 *
 * Triggered with `concurrencyKey: applicationId` on a queue with a limit of
 * one, so an application can only ever have a single checkout in flight.
 */

/** How long the citizen has to complete the payment page. */
const CHECKOUT_WINDOW_SECONDS = 20 * 60;

export const collectFee = schemaTask({
  id: "payment.collect",
  schema: collectFeeSchema,
  queue: applicationPaymentQueue,
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (payload, { signal }): Promise<SettlementOutcome> => {
    // A citizen mashing "pay" is throttled here, before an order exists.
    await requireDailyQuota(payload.applicationId, "PAYMENT_ATTEMPTS_PER_APPLICATION_PER_DAY");

    const quote = quoteFee({
      service: payload.service,
      covs: payload.covs,
      previousValidTill: payload.previousValidTill,
      testAttempt: payload.testAttempt,
      deliverByPost: payload.deliverByPost,
    });
    if (quote.ineligibleReason) {
      throw new PermanentValidationError("SERVICE_INELIGIBLE", quote.ineligibleReason);
    }
    if (quote.totalPaise <= 0) {
      return { outcome: "PAID", paymentId: "no-fee", amountPaise: 0, reason: "no fee payable" };
    }

    // Deterministic across retries and across browser tabs: the same fee for
    // the same application and attempt is always the same payment row.
    const feeKey = stableKey("fee", payload.applicationId, payload.feePurpose, payload.testAttempt, quote.totalPaise);
    const { payment, created } = await store.createPaymentIfAbsent({
      id: newId("pay"),
      idempotencyKey: feeKey,
      applicationId: payload.applicationId,
      citizenId: payload.citizenId,
      purpose: payload.feePurpose,
      lines: quote.lines,
    });

    if (payment.status === "CAPTURED") {
      logger.info("Fee already collected", { paymentId: payment.id, applicationId: payload.applicationId });
      return { outcome: "PAID", paymentId: payment.id, amountPaise: payment.amountPaise };
    }
    if (payment.status === "REFUNDED" || payment.status === "REFUND_PENDING" || payment.status === "REFUND_FAILED") {
      // Re-collecting a refunded fee would reuse the gateway order. The caller
      // must raise the attempt number so a fresh key is derived.
      throw new PermanentValidationError(
        "FEE_ALREADY_REFUNDED",
        `Payment ${payment.id} was refunded; start a new attempt to collect again`,
      );
    }
    if (!created && payment.amountPaise !== quote.totalPaise) {
      // The quote moved under us — almost always a late fee crossing a year
      // boundary mid-checkout. Charging the stale amount would under-collect.
      throw new PermanentValidationError(
        "FEE_CHANGED",
        `Fee changed from ${formatRupees(payment.amountPaise)} to ${formatRupees(quote.totalPaise)}; resubmit`,
      );
    }

    // The idempotency key on the token means a retried attempt of this run
    // rejoins the original waitpoint instead of orphaning it.
    const token = await wait.createToken({
      idempotencyKey: `payment-settlement:${payment.id}`,
      idempotencyKeyTTL: "24h",
      timeout: `${Math.ceil(CHECKOUT_WINDOW_SECONDS / 60)}m`,
      tags: [`payment:${payment.id}`, `application:${payload.applicationId}`],
    });

    const order = await paymentGateway.createOrder({
      idempotencyKey: feeKey,
      amountPaise: quote.totalPaise,
      applicationId: payload.applicationId,
      citizenId: payload.citizenId,
      callbackUrl: token.url,
      expiresInSeconds: CHECKOUT_WINDOW_SECONDS,
      signal,
    });

    await store.updatePayment(payment.id, { gatewayOrderId: order.orderId, waitTokenId: token.id });

    const application = await store.getApplication(payload.applicationId);
    if (application) {
      await notifyCitizen({
        citizenId: payload.citizenId,
        event: "FEE_DUE",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `fee-due:${payment.id}`,
        variables: {
          applicationId: payload.applicationId,
          amount: formatRupees(quote.totalPaise),
          expiresAt: order.expiresAt,
          checkoutUrl: order.checkoutUrl,
        },
      });
    }

    // Suspended here. No worker is held while the citizen pays.
    const settlement = await wait.forToken<GatewayEvent>(token);

    if (!settlement.ok) {
      logger.info("Settlement callback did not arrive; falling back to polling", {
        paymentId: payment.id,
        orderId: order.orderId,
      });
      const polled = await pollPaymentStatus
        .triggerAndWait({ paymentId: payment.id, orderId: order.orderId }, POLL_TRIGGER_OPTIONS)
        .unwrap();
      return settlePayment(payment.id, polled);
    }

    // The webhook fired. Re-read anyway: a forged or replayed body must not be
    // able to mark an unpaid application as paid, and the gateway is the only
    // thing allowed to answer that question.
    const state = await paymentGateway.getPayment(order.orderId, signal);
    logger.info("Settlement callback received", {
      paymentId: payment.id,
      callbackEvent: settlement.output.event,
      gatewayStatus: state.status,
    });
    return settlePayment(payment.id, state);
  },
});

/** Collect a fee for an application, always serialised on that application. */
export async function collectFeeFor(
  input: Parameters<typeof collectFee.triggerAndWait>[0],
): Promise<SettlementOutcome | { outcome: "FAILED"; paymentId: string; amountPaise: number; reason: string }> {
  const result = await collectFee.triggerAndWait(input, {
    concurrencyKey: input.applicationId,
    priority: PRIORITY.PAYMENT,
    ttl: TTL.INTERACTIVE,
    tags: [`application:${input.applicationId}`, `citizen:${input.citizenId}`],
  });

  if (result.ok) return result.output;
  return {
    outcome: "FAILED",
    paymentId: "unknown",
    amountPaise: 0,
    reason: result.error instanceof Error ? result.error.message : "fee collection failed",
  };
}
