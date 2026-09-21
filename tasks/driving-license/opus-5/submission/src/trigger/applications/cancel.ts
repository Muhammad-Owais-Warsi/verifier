import { logger, task } from "@trigger.dev/sdk";
import type { Application, Payment } from "../../lib/domain";
import { stableKey } from "../../lib/ids";
import type { RefundReason } from "../../lib/schemas";
import { hasPaidFee, isTerminal } from "../../lib/state-machine";
import { store } from "../../lib/store";
import { notifyCitizen } from "../notifications/dispatch";
import { requestRefund } from "../payments/refund";
import { citizenPipelineQueue } from "../queues";

/**
 * Withdrawal, by the citizen or by the system.
 *
 * The interesting part is the refund policy. A government fee is refundable
 * only for a service that was not rendered: once the citizen has actually sat
 * the test, the test fee has been consumed whatever happens next, while the
 * card and postage components have not. So the refund is computed per fee
 * head rather than as a single amount.
 */

/** Fee heads that are consumed the moment the appointment is served. */
const CONSUMED_ON_TEST = new Set(["LL_TEST", "LL_TEST_REPEAT", "DRIVING_TEST", "DRIVING_TEST_REPEAT"]);
/** Statutory processing fees, not refundable once the application is examined. */
const CONSUMED_ON_EXAMINATION = new Set(["LL_FEE", "DL_ISSUE", "DL_RENEWAL", "DL_ADD_COV", "DL_PARTICULARS_CHANGE", "IDP"]);

export const cancelApplication = task({
  id: "application.cancel",
  queue: citizenPipelineQueue,
  maxDuration: 180,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload: {
    applicationId: string;
    citizenId: string;
    reason: string;
    refundReason?: RefundReason;
    /** EXPIRED is the sweeper's path; CANCELLED is the citizen's. */
    finalStatus?: "CANCELLED" | "EXPIRED";
  }) => {
    const application = await store.getApplication(payload.applicationId);
    if (!application) return { cancelled: false, reason: "unknown application" };
    if (isTerminal(application.status)) {
      return { cancelled: false, reason: `already ${application.status}` };
    }

    // Free the seat first: an abandoned application holding a test slot is a
    // seat nobody else in the district can book.
    if (application.slotId) {
      await store.releaseHold(stableKey("hold", application.id, application.slotId));
    }

    let refundedPaise = 0;
    if (hasPaidFee(application.status)) {
      const captured = await store.listCapturedPaymentsForApplication(application.id);
      for (const payment of captured) {
        const amount = await refundableAmount(payment, application);
        if (amount <= 0) continue;
        await requestRefund({
          paymentId: payment.id,
          amountPaise: amount,
          reason: payload.refundReason ?? "APPLICATION_CANCELLED",
        });
        refundedPaise += amount;
      }
    }

    const finalStatus = payload.finalStatus ?? "CANCELLED";
    await store.transitionApplication(application.id, finalStatus, {
      reason: payload.reason,
      patch: { rejectionReason: payload.reason },
    });

    if (finalStatus === "EXPIRED") {
      await notifyCitizen({
        citizenId: payload.citizenId,
        event: "APPLICATION_EXPIRED",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `expired:${application.id}`,
        variables: { applicationId: application.id },
      });
    }

    logger.info("Application closed", { applicationId: application.id, finalStatus, refundedPaise });
    return { cancelled: true, finalStatus, refundedPaise };
  },
});

async function refundableAmount(payment: Payment, application: Application): Promise<number> {
  const testTaken = (await store.getTestAttempt(application.id)) > 0;
  const examined = application.history.some((entry) => entry.to === "DOCS_PENDING" || entry.to === "RTO_REVIEW");

  return payment.lines.reduce((sum, line) => {
    if (testTaken && CONSUMED_ON_TEST.has(stripCovSuffix(line.head))) return sum;
    if (examined && CONSUMED_ON_EXAMINATION.has(stripCovSuffix(line.head))) return sum;
    return sum + line.amountPaise;
  }, 0);
}

/** `LL_FEE_MCWG` and `LL_FEE_LMV` are the same fee head for refund purposes. */
function stripCovSuffix(head: string): string {
  return head.startsWith("LL_FEE_") ? "LL_FEE" : head;
}
