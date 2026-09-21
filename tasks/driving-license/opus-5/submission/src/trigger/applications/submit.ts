import { logger, schemaTask } from "@trigger.dev/sdk";
import type { Application, ApplicationStatus } from "../../lib/domain";
import { checkEligibility } from "../../lib/eligibility";
import { requireDailyQuota } from "../../lib/fair-use";
import { submitApplicationSchema } from "../../lib/schemas";
import { isTerminal } from "../../lib/state-machine";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { KYC_TRIGGER_OPTIONS, runEkyc, verifyDocument } from "../kyc/verify";
import { notifyCitizen } from "../notifications/dispatch";
import { collectFeeFor } from "../payments/collect";
import { citizenPipelineQueue, PRIORITY, TTL } from "../queues";
import { checkEnforcement, lookupNationalRegister } from "../sync/national-register";
import { advanceAfterFee } from "./advance";

/**
 * The application pipeline.
 *
 * Runs on the per-citizen fairness queue with a concurrency limit of one, so a
 * citizen — or a script using a citizen's credentials — occupies exactly one
 * worker no matter how many applications they push. Every expensive step is
 * delegated to a task on a capacity queue, which is also what keeps this run
 * cheap while it is suspended waiting for payment.
 *
 * The order of the steps is the important part: everything that can reject the
 * application for free happens before anything that costs the citizen money.
 */

export type SubmissionOutcome = {
  applicationId: string;
  status: ApplicationStatus;
  outcome:
    | "PROCEEDING"
    | "ALREADY_CLOSED"
    | "INELIGIBLE"
    | "KYC_FAILED"
    | "DUPLICATE_LICENCE"
    | "DISQUALIFIED"
    | "DOCS_REJECTED"
    | "MANUAL_REVIEW"
    | "AWAITING_PAYMENT"
    | "PAYMENT_FAILED";
  reason?: string;
};

export const submitApplication = schemaTask({
  id: "application.submit",
  schema: submitApplicationSchema,
  queue: citizenPipelineQueue,
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload): Promise<SubmissionOutcome> => {
    const { citizenId } = payload.applicant;
    await requireDailyQuota(citizenId, "APPLICATIONS_PER_CITIZEN_PER_DAY");

    const draft: Application = {
      id: payload.applicationId,
      service: payload.service,
      status: "DRAFT",
      applicant: payload.applicant,
      covs: payload.covs,
      documents: payload.documents,
      rtoCode: payload.applicant.rtoCode,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      history: [],
    };
    const { application, created } = await store.createApplicationIfAbsent(draft);
    await store.saveContact({
      citizenId,
      mobile: payload.applicant.mobile,
      email: payload.applicant.email,
      language: payload.applicant.language,
    });

    if (!created && isTerminal(application.status)) {
      return { applicationId: application.id, status: application.status, outcome: "ALREADY_CLOSED" };
    }

    await store.transitionApplication(application.id, "SUBMITTED", { reason: `portal submission ${payload.submissionNonce}` });
    await notifyCitizen({
      citizenId,
      event: "APPLICATION_SUBMITTED",
      mobile: payload.applicant.mobile,
      email: payload.applicant.email,
      language: payload.applicant.language,
      dedupeKey: `submitted:${application.id}`,
      variables: { applicationId: application.id, service: payload.service },
    });

    // 1. Statutory eligibility. Pure local computation, so a citizen who is
    //    under-age or missing a medical certificate finds out immediately and
    //    for free.
    const findings = checkEligibility({
      service: payload.service,
      applicant: payload.applicant,
      covs: payload.covs,
      documents: payload.documents,
    });
    if (findings.length > 0) {
      const reason = findings.map((finding) => finding.message).join("; ");
      await store.transitionApplication(application.id, "REJECTED", { reason, patch: { rejectionReason: reason } });
      await notifyCitizen({
        citizenId,
        event: "DOCS_REJECTED",
        mobile: payload.applicant.mobile,
        email: payload.applicant.email,
        language: payload.applicant.language,
        dedupeKey: `ineligible:${application.id}`,
        variables: { applicationId: application.id, reason: findings[0]?.message ?? "ineligible" },
      });
      return { applicationId: application.id, status: "REJECTED", outcome: "INELIGIBLE", reason };
    }

    // 2. Aadhaar eKYC.
    await store.transitionApplication(application.id, "KYC_PENDING", { reason: "eKYC started" });
    const ekyc = await runEkyc
      .triggerAndWait(
        {
          applicationId: application.id,
          citizenId,
          referenceToken: payload.ekycReferenceToken,
          fullName: payload.applicant.fullName,
          dateOfBirth: payload.applicant.dateOfBirth,
        },
        KYC_TRIGGER_OPTIONS,
      )
      .unwrap();

    if (!ekyc.matched) {
      const reason = `Aadhaar details do not match: ${ekyc.mismatchedFields.join(", ")}`;
      await store.transitionApplication(application.id, "KYC_FAILED", { reason, patch: { rejectionReason: reason } });
      await notifyCitizen({
        citizenId,
        event: "KYC_FAILED",
        mobile: payload.applicant.mobile,
        email: payload.applicant.email,
        language: payload.applicant.language,
        dedupeKey: `kyc-failed:${application.id}`,
        variables: { applicationId: application.id, reason },
      });
      return { applicationId: application.id, status: "KYC_FAILED", outcome: "KYC_FAILED", reason };
    }

    // 3. One licence per person, nationwide. Checked against the National
    //    Register rather than our own state, because the citizen may hold a
    //    licence issued anywhere in India.
    if (payload.service === "LL_NEW" || payload.service === "DL_NEW") {
      const existing = await lookupNationalRegister
        .triggerAndWait({ demographicHash: ekyc.demographicHash }, { priority: PRIORITY.INTERACTIVE, ttl: TTL.INTERACTIVE })
        .unwrap();
      if (existing && existing.status === "ACTIVE") {
        const reason = `An active licence (${existing.dlNumber}) already exists in ${existing.state}`;
        await store.transitionApplication(application.id, "REJECTED", { reason, patch: { rejectionReason: reason } });
        return { applicationId: application.id, status: "REJECTED", outcome: "DUPLICATE_LICENCE", reason };
      }
    }

    // 4. Enforcement. A court disqualification or an active suspension blocks
    //    every service on that licence.
    if (payload.applicant.existingDlNumber) {
      const enforcement = await checkEnforcement
        .triggerAndWait(
          { dlNumber: payload.applicant.existingDlNumber },
          { priority: PRIORITY.INTERACTIVE, ttl: TTL.INTERACTIVE },
        )
        .unwrap();
      if (enforcement.blocked) {
        await store.transitionApplication(application.id, "REJECTED", {
          reason: enforcement.reason,
          patch: { rejectionReason: enforcement.reason },
        });
        return {
          applicationId: application.id,
          status: "REJECTED",
          outcome: "DISQUALIFIED",
          reason: enforcement.reason,
        };
      }
    }

    // 5. Documents, verified in parallel on the document queue.
    await store.transitionApplication(application.id, "DOCS_PENDING", { reason: "document verification started" });
    const photo = payload.documents.find((document) => document.kind === "PASSPORT_PHOTO");
    const verdicts = await verifyDocument.batchTriggerAndWait(
      payload.documents.map((document) => ({
        payload: { applicationId: application.id, citizenId, document, referenceFaceKey: photo?.storageKey },
        options: KYC_TRIGGER_OPTIONS,
      })),
    );

    const rejected: string[] = [];
    let needsReview = false;
    for (const run of verdicts.runs) {
      if (!run.ok) {
        // A verifier that could not reach a verdict is not a rejection. Park
        // the application for an officer rather than penalising the citizen.
        needsReview = true;
        continue;
      }
      if (run.output.outcome === "REJECTED") rejected.push(`${run.output.kind}: ${run.output.reasons.join(", ")}`);
      if (run.output.outcome === "MANUAL_REVIEW") needsReview = true;
    }

    if (rejected.length > 0) {
      const reason = rejected.join("; ");
      await store.transitionApplication(application.id, "DOCS_REJECTED", { reason });
      await notifyCitizen({
        citizenId,
        event: "DOCS_REJECTED",
        mobile: payload.applicant.mobile,
        email: payload.applicant.email,
        language: payload.applicant.language,
        dedupeKey: `docs-rejected:${application.id}:${rejected.length}`,
        variables: { applicationId: application.id, reason: rejected[0] ?? "document rejected" },
      });
      return { applicationId: application.id, status: "DOCS_REJECTED", outcome: "DOCS_REJECTED", reason };
    }

    if (needsReview) {
      await store.transitionApplication(application.id, "ON_HOLD", { reason: "document requires officer review" });
      return { applicationId: application.id, status: "ON_HOLD", outcome: "MANUAL_REVIEW" };
    }

    // 6. Only now does the citizen pay.
    await store.transitionApplication(application.id, "FEE_PENDING", { reason: "documents verified" });
    const settlement = await collectFeeFor({
      applicationId: application.id,
      citizenId,
      service: payload.service,
      covs: payload.covs,
      testAttempt: 1,
      deliverByPost: payload.deliverByPost,
      feePurpose: "APPLICATION",
    });

    if (settlement.outcome === "PENDING") {
      // The debit is unresolved. The application stays in FEE_PENDING and the
      // settlement sweep picks it up; nothing here guesses.
      logger.warn("Application parked awaiting payment confirmation", {
        applicationId: application.id,
        paymentId: settlement.paymentId,
      });
      return {
        applicationId: application.id,
        status: "FEE_PENDING",
        outcome: "AWAITING_PAYMENT",
        reason: settlement.reason,
      };
    }
    if (settlement.outcome === "FAILED") {
      return {
        applicationId: application.id,
        status: "FEE_PENDING",
        outcome: "PAYMENT_FAILED",
        reason: settlement.reason,
      };
    }

    await store.transitionApplication(application.id, "FEE_PAID", {
      reason: `fee collected (${settlement.paymentId})`,
      patch: { paymentId: settlement.paymentId },
    });

    // Handed over rather than awaited: the continuation runs on the same
    // per-citizen queue, and a queue with a limit of one cannot wait on itself.
    await advanceAfterFee.trigger(
      { applicationId: application.id, citizenId },
      { concurrencyKey: citizenId, priority: PRIORITY.INTERACTIVE, ttl: TTL.BACKGROUND, tags: [`application:${application.id}`] },
    );

    return { applicationId: application.id, status: "FEE_PAID", outcome: "PROCEEDING" };
  },
});
