import { logger } from "@trigger.dev/sdk";
import type { Payment } from "../../lib/domain";
import { formatRupees } from "../../lib/fees";
import type { GatewayPaymentState } from "../../lib/providers/payment-gateway";
import { store } from "../../lib/store";
import { isTerminal } from "../../lib/state-machine";
import { notifyCitizen } from "../notifications/dispatch";
import { requestRefund } from "./refund";

/**
 * Turning a gateway status into a decision.
 *
 * This is deliberately one function shared by the checkout flow, the webhook
 * handler and the nightly settlement sweep. All three can observe the same
 * payment, sometimes at the same moment, and if they each had their own
 * interpretation of "captured but the application is gone" the system would
 * refund twice or not at all. One function, driven off freshly-read state,
 * with every branch idempotent.
 *
 * The edge cases it exists to handle:
 *
 *  - money captured after the application was cancelled or expired
 *  - captured amount that does not match what we asked for, in either direction
 *  - a second capture for a fee that was already paid through another channel
 *  - the gateway saying "refunded" before we ever asked
 *  - a status that is still not terminal, which must never be read as failure
 */

export type SettlementOutcome = {
  outcome: "PAID" | "FAILED" | "PENDING";
  paymentId: string;
  amountPaise: number;
  reason?: string;
};

export async function settlePayment(paymentId: string, state: GatewayPaymentState): Promise<SettlementOutcome> {
  const payment = await store.getPayment(paymentId);
  if (!payment) {
    return { outcome: "FAILED", paymentId, amountPaise: 0, reason: "unknown payment" };
  }

  switch (state.status) {
    case "CAPTURED":
      return settleCapture(payment, state);

    case "FAILED":
    case "EXPIRED": {
      if (payment.status !== "CAPTURED") {
        await store.updatePayment(payment.id, {
          status: state.status === "EXPIRED" ? "EXPIRED" : "FAILED",
          failureReason: state.failureCode,
        });
      }
      await notifyPaymentFailure(payment, state.failureCode);
      return { outcome: "FAILED", paymentId: payment.id, amountPaise: 0, reason: state.failureCode ?? state.status };
    }

    case "REFUNDED": {
      // The gateway's own risk engine reversed it. Our ledger has to follow.
      await store.updatePayment(payment.id, {
        status: "REFUNDED",
        refundedAmountPaise: state.refundedAmountPaise ?? payment.amountPaise,
      });
      return { outcome: "FAILED", paymentId: payment.id, amountPaise: 0, reason: "reversed by gateway" };
    }

    default: {
      // CREATED, PENDING or AUTHORIZED-but-not-captured. The citizen may have
      // been debited, so this is emphatically not a failure. Park it for the
      // settlement sweep and tell the caller to hold the application.
      await store.updatePayment(payment.id, { status: "PENDING_RECONCILIATION" });
      logger.warn("Payment left pending reconciliation", {
        paymentId: payment.id,
        gatewayStatus: state.status,
        orderId: state.orderId,
      });
      return { outcome: "PENDING", paymentId: payment.id, amountPaise: payment.amountPaise, reason: state.status };
    }
  }
}

async function settleCapture(payment: Payment, state: GatewayPaymentState): Promise<SettlementOutcome> {
  const captured = state.capturedAmountPaise ?? state.amountPaise;
  const expected = payment.amountPaise;

  if (payment.status !== "CAPTURED") {
    await store.updatePayment(payment.id, {
      status: "CAPTURED",
      gatewayPaymentId: state.paymentId,
      capturedAmountPaise: captured,
    });
  }

  const application = await store.getApplication(payment.applicationId);

  // Money arrived for something that no longer exists. Give it back rather than
  // leaving the citizen to discover it on a bank statement.
  if (!application || isTerminal(application.status)) {
    await requestRefund({
      paymentId: payment.id,
      amountPaise: captured,
      reason: application ? "APPLICATION_CANCELLED" : "LATE_SETTLEMENT",
      orphaned: !application,
    });
    return {
      outcome: "FAILED",
      paymentId: payment.id,
      amountPaise: captured,
      reason: "captured after the application closed; refund issued",
    };
  }

  if (captured < expected) {
    // A partial capture cannot buy a partial licence. Return all of it and let
    // the citizen pay again cleanly.
    await requestRefund({ paymentId: payment.id, amountPaise: captured, reason: "SERVICE_FAILURE" });
    return {
      outcome: "FAILED",
      paymentId: payment.id,
      amountPaise: captured,
      reason: `short capture: expected ${formatRupees(expected)}, received ${formatRupees(captured)}`,
    };
  }

  if (captured > expected) {
    // Keep the fee, return the difference. The application proceeds.
    await requestRefund({ paymentId: payment.id, amountPaise: captured - expected, reason: "OVERPAYMENT" });
    logger.warn("Overpayment refunded", { paymentId: payment.id, excessPaise: captured - expected });
  }

  await refundDuplicateCaptures(payment);
  await notifyPaymentSuccess(payment, expected);

  return { outcome: "PAID", paymentId: payment.id, amountPaise: expected };
}

/**
 * The same fee captured more than once — the citizen paid online and again at
 * the RTO counter, or an old order was completed from a stale browser tab.
 * Only one survives; the rest go back automatically.
 */
async function refundDuplicateCaptures(keep: Payment): Promise<void> {
  const captured = await store.listCapturedPaymentsForApplication(keep.applicationId);
  for (const other of captured) {
    if (other.id === keep.id) continue;
    if (other.purpose !== keep.purpose) continue;
    logger.warn("Duplicate capture detected", {
      applicationId: keep.applicationId,
      keeping: keep.id,
      refunding: other.id,
    });
    await requestRefund({
      paymentId: other.id,
      amountPaise: other.capturedAmountPaise ?? other.amountPaise,
      reason: "DUPLICATE_PAYMENT",
    });
  }
}

async function notifyPaymentSuccess(payment: Payment, amountPaise: number): Promise<void> {
  const application = await store.getApplication(payment.applicationId);
  if (!application) return;
  await notifyCitizen({
    citizenId: payment.citizenId,
    event: "PAYMENT_SUCCESS",
    mobile: application.applicant.mobile,
    email: application.applicant.email,
    language: application.applicant.language,
    dedupeKey: `payment-success:${payment.id}`,
    variables: {
      applicationId: payment.applicationId,
      amount: formatRupees(amountPaise),
      paymentId: payment.id,
    },
  });
}

async function notifyPaymentFailure(payment: Payment, failureCode?: string): Promise<void> {
  const application = await store.getApplication(payment.applicationId);
  if (!application) return;
  await notifyCitizen({
    citizenId: payment.citizenId,
    event: "PAYMENT_FAILED",
    mobile: application.applicant.mobile,
    email: application.applicant.email,
    language: application.applicant.language,
    dedupeKey: `payment-failed:${payment.id}:${failureCode ?? "unknown"}`,
    variables: { applicationId: payment.applicationId, amount: formatRupees(payment.amountPaise) },
  });
}
