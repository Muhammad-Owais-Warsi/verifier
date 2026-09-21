import { logger, task } from "@trigger.dev/sdk";
import type { ApplicantDocument } from "../../lib/domain";
import { requireDailyQuota } from "../../lib/fair-use";
import type { DocumentVerdict, EkycResult } from "../../lib/providers/identity";
import { identity } from "../../lib/providers/identity";
import { documentQueue, ekycQueue, PRIORITY, TTL } from "../queues";

/**
 * Identity checks. Both tasks live on capacity queues because they exist to
 * protect a metered upstream: UIDAI bills per eKYC and audits misuse, and the
 * document pipeline is a GPU fleet with a fixed size.
 *
 * Per-citizen fairness is not enforced here — the caller is already serialised
 * on the citizen pipeline queue — but the per-day quotas are, because those
 * bound how much a citizen can spend of a national resource.
 */

export const runEkyc = task({
  id: "kyc.ekyc",
  queue: ekycQueue,
  ttl: TTL.INTERACTIVE,
  maxDuration: 120,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (
    payload: { applicationId: string; citizenId: string; referenceToken: string; fullName: string; dateOfBirth: string },
    { signal },
  ): Promise<EkycResult> => {
    await requireDailyQuota(payload.citizenId, "EKYC_PER_CITIZEN_PER_DAY");

    const result = await identity.ekyc({
      referenceToken: payload.referenceToken,
      fullName: payload.fullName,
      dateOfBirth: payload.dateOfBirth,
      signal,
    });

    // Field names only. The values are Aadhaar demographics and must not be
    // written to a log line or a span attribute.
    logger.info("eKYC completed", {
      applicationId: payload.applicationId,
      matched: result.matched,
      mismatchedFields: result.mismatchedFields,
    });
    return result;
  },
});

export const verifyDocument = task({
  id: "kyc.verify-document",
  queue: documentQueue,
  ttl: TTL.INTERACTIVE,
  maxDuration: 180,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 3_000, maxTimeoutInMs: 45_000, randomize: true },
  run: async (
    payload: { applicationId: string; citizenId: string; document: ApplicantDocument; referenceFaceKey?: string },
    { signal },
  ): Promise<DocumentVerdict> => {
    await requireDailyQuota(payload.citizenId, "DOCUMENT_SCANS_PER_CITIZEN_PER_DAY");

    const verdict = await identity.verifyDocument({
      applicationId: payload.applicationId,
      document: payload.document,
      referenceFaceKey: payload.referenceFaceKey,
      signal,
    });

    logger.info("Document verdict", {
      applicationId: payload.applicationId,
      kind: payload.document.kind,
      outcome: verdict.outcome,
    });
    return verdict;
  },
});

/** Shared trigger options, so callers cannot accidentally deprioritise KYC. */
export const KYC_TRIGGER_OPTIONS = {
  priority: PRIORITY.INTERACTIVE,
  ttl: TTL.INTERACTIVE,
} as const;
