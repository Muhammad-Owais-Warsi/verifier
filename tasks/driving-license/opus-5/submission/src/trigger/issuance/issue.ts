import { logger, schemaTask } from "@trigger.dev/sdk";
import type { Licence } from "../../lib/domain";
import { computeValidity, learnerValidity } from "../../lib/eligibility";
import { PermanentValidationError } from "../../lib/errors";
import { formatLicenceNumber } from "../../lib/ids";
import { issueLicenceSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { notifyCitizen } from "../notifications/dispatch";
import { citizenPipelineQueue, PRIORITY, TTL } from "../queues";
import { pushToNationalRegister } from "../sync/national-register";
import { pushToDigiLocker } from "../sync/digilocker";
import { queueCardPrint } from "./dispatch";

/**
 * Issuance.
 *
 * The moment a licence number exists it becomes a national fact, so this task
 * is written to be exactly-once in the only way that matters: the number is
 * minted behind a claim, and every downstream publication (register, wallet,
 * card) is triggered with an idempotency key derived from that number. Running
 * this twice produces one licence and one card.
 */

export const issueLicence = schemaTask({
  id: "licence.issue",
  schema: issueLicenceSchema,
  queue: citizenPipelineQueue,
  maxDuration: 300,
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload) => {
    const application = await store.getApplication(payload.applicationId);
    if (!application) {
      throw new PermanentValidationError("UNKNOWN_APPLICATION", `No application ${payload.applicationId}`);
    }
    if (application.licenceNumber) {
      logger.info("Licence already issued", { applicationId: application.id, dlNumber: application.licenceNumber });
      return { dlNumber: application.licenceNumber, reissued: false };
    }
    if (application.status !== "TEST_PASSED" && application.status !== "RTO_REVIEW" && application.status !== "APPROVED") {
      throw new PermanentValidationError(
        "NOT_ISSUABLE",
        `Application ${application.id} is ${application.status}, not ready for issuance`,
      );
    }

    // The claim, not the status, is what makes this exactly-once: two runs that
    // both read APPROVED cannot both mint a number.
    if ((await store.claimOnce(`issue:${application.id}`)) === "ALREADY_CLAIMED") {
      const existing = await store.getApplication(application.id);
      return { dlNumber: existing?.licenceNumber ?? "", reissued: true };
    }

    const issuedAt = new Date();
    const serial = await store.nextLicenceSerial(payload.rtoCode, issuedAt.getUTCFullYear());
    const dlNumber = formatLicenceNumber(payload.rtoCode, issuedAt.getUTCFullYear(), serial);

    const isLearner = payload.service === "LL_NEW" || payload.service === "LL_ADD_COV";
    const validity = isLearner
      ? { validTill: learnerValidity(issuedAt) }
      : computeValidity({ dateOfBirth: application.applicant.dateOfBirth, covs: payload.covs, issuedAt });

    const licence: Licence = {
      number: dlNumber,
      citizenId: payload.citizenId,
      rtoCode: payload.rtoCode,
      covs: payload.covs,
      issuedAt: issuedAt.toISOString(),
      validTill: validity.validTill,
      transportValidTill: "transportValidTill" in validity ? validity.transportValidTill : undefined,
      status: "ACTIVE",
      revision: 1,
      updatedAt: nowIso(),
    };
    await store.saveLicence(licence);

    await store.transitionApplication(application.id, "APPROVED", {
      reason: `licence ${dlNumber} issued`,
      patch: { licenceNumber: dlNumber },
    });

    await notifyCitizen({
      citizenId: payload.citizenId,
      event: "LICENCE_ISSUED",
      mobile: application.applicant.mobile,
      email: application.applicant.email,
      language: application.applicant.language,
      dedupeKey: `licence-issued:${dlNumber}`,
      variables: { dlNumber, validTill: validity.validTill },
    });

    // Publication is fire-and-forget on purpose: the citizen is already
    // licensed, and a slow National Register must not hold up the response or
    // the card. Each of these is independently retried and dead-lettered.
    await pushToNationalRegister.trigger(
      { dlNumber },
      { priority: PRIORITY.STANDARD, ttl: TTL.BACKGROUND, idempotencyKey: `nr-push:${dlNumber}:1`, tags: [`licence:${dlNumber}`] },
    );
    await pushToDigiLocker.trigger(
      { dlNumber, citizenId: payload.citizenId, isRenewal: payload.service === "DL_RENEWAL" },
      { priority: PRIORITY.STANDARD, ttl: TTL.BACKGROUND, idempotencyKey: `digilocker:${dlNumber}`, tags: [`licence:${dlNumber}`] },
    );

    // A learner's licence is a PDF, not a card; nothing gets printed.
    if (!isLearner) {
      await queueCardPrint.trigger(
        { applicationId: application.id, citizenId: payload.citizenId, dlNumber, rtoCode: payload.rtoCode },
        { priority: PRIORITY.STANDARD, ttl: TTL.BACKGROUND, idempotencyKey: `print:${dlNumber}`, tags: [`licence:${dlNumber}`] },
      );
    }

    logger.info("Licence issued", { applicationId: application.id, dlNumber, validTill: validity.validTill });
    return { dlNumber, reissued: false };
  },
});
