import { logger, schemaTask } from "@trigger.dev/sdk";
import { ManualInterventionRequired, TransientUpstreamError } from "../../lib/errors";
import { formatRupees } from "../../lib/fees";
import { newId, stableKey } from "../../lib/ids";
import { paymentGateway } from "../../lib/providers/payment-gateway";
import type { RefundReason } from "../../lib/schemas";
import { refundSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { notifyCitizen } from "../notifications/dispatch";
import { gatewayQueue, PRIORITY, TTL } from "../queues";

/**
 * Refunds.
 *
 * Money leaving the exchequer is the one operation that must never happen
 * twice, so the refund id is derived from the payment, the reason and the
 * amount rather than generated. The same derivation on a retry, on a
 * reconciliation sweep and on a manual replay all produce the same id, and the
 * gateway collapses them into one refund.
 *
 * The other half of the contract is that a refund is never silently abandoned:
 * exhausting the retries parks the case in the dead-letter table with enough
 * context for the treasury team, and raises an error the operator will see.
 */

export type RefundOutcome = {
  outcome: "REFUNDED" | "PENDING" | "NOT_REQUIRED";
  refundId?: string;
  amountPaise: number;
};

export const refundPayment = schemaTask({
  id: "payment.refund",
  schema: refundSchema,
  queue: gatewayQueue,
  maxDuration: 120,
  retry: { maxAttempts: 8, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 300_000, randomize: true },
  run: async (payload, { signal }): Promise<RefundOutcome> => {
    const payment = await store.getPayment(payload.paymentId);
    if (!payment) {
      throw new ManualInterventionRequired(payload.paymentId, "Refund requested for an unknown payment");
    }

    if (payment.status === "REFUNDED") {
      return { outcome: "NOT_REQUIRED", refundId: payment.refundId, amountPaise: payment.refundedAmountPaise ?? 0 };
    }
    if (payment.status !== "CAPTURED" && payment.status !== "REFUND_PENDING" && !payload.orphaned) {
      // Nothing was ever captured, so there is nothing to give back. Returning
      // rather than throwing keeps cancellation flows simple.
      return { outcome: "NOT_REQUIRED", amountPaise: 0 };
    }
    if (!payment.gatewayPaymentId) {
      throw new ManualInterventionRequired(payment.id, "Captured payment has no gateway payment id");
    }

    const refundId = stableKey("rfnd", payment.id, payload.reason, payload.amountPaise);
    await store.updatePayment(payment.id, { status: "REFUND_PENDING", refundId });

    const result = await paymentGateway.refund({
      refundId,
      paymentId: payment.gatewayPaymentId,
      amountPaise: payload.amountPaise,
      reason: payload.reason,
      signal,
    });

    if (result.status === "FAILED") {
      // Usually a closed card or a bank outage. Retryable, and the idempotent
      // refund id means a retry cannot double-pay.
      throw new TransientUpstreamError("payment-gateway", `refund failed: ${result.failureCode ?? "unknown"}`);
    }

    if (result.status === "PENDING") {
      logger.info("Refund accepted, awaiting bank settlement", { paymentId: payment.id, refundId });
      return { outcome: "PENDING", refundId, amountPaise: payload.amountPaise };
    }

    await store.updatePayment(payment.id, {
      status: "REFUNDED",
      refundedAmountPaise: (payment.refundedAmountPaise ?? 0) + payload.amountPaise,
      refundId,
    });

    const application = await store.getApplication(payment.applicationId);
    if (application) {
      await notifyCitizen({
        citizenId: payment.citizenId,
        event: "PAYMENT_REFUNDED",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `refund:${refundId}`,
        variables: {
          applicationId: payment.applicationId,
          amount: formatRupees(payload.amountPaise),
          refundId,
        },
      });
    }

    logger.info("Refund processed", { paymentId: payment.id, refundId, reason: payload.reason });
    return { outcome: "REFUNDED", refundId, amountPaise: payload.amountPaise };
  },
  onFailure: async ({ payload, error }) => {
    await store.updatePayment(payload.paymentId, { status: "REFUND_FAILED" }).catch(() => undefined);
    await store.recordDeadLetter({
      id: newId("dlq"),
      kind: "payment.refund",
      reference: payload.paymentId,
      payload,
      error: error instanceof Error ? error.message : String(error),
      attempts: 8,
      createdAt: nowIso(),
    });
  },
});

/** Every refund is queued the same way: high priority, generous TTL. */
export async function requestRefund(input: {
  paymentId: string;
  amountPaise: number;
  reason: RefundReason;
  orphaned?: boolean;
}): Promise<void> {
  await refundPayment.trigger(
    { paymentId: input.paymentId, amountPaise: input.amountPaise, reason: input.reason, orphaned: input.orphaned ?? false },
    { priority: PRIORITY.PAYMENT, ttl: TTL.BACKGROUND, tags: [`payment:${input.paymentId}`, "refund"] },
  );
}
