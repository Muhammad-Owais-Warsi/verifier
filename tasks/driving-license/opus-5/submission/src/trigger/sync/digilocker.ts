import { logger, task } from "@trigger.dev/sdk";
import { PermanentValidationError } from "../../lib/errors";
import { digiLocker } from "../../lib/providers/registries";
import { store } from "../../lib/store";
import { digilockerQueue, TTL } from "../queues";

/**
 * Publishing the licence to the citizen's DigiLocker.
 *
 * For most people this, not the plastic card, is the licence they will actually
 * produce at a checkpoint, so it is pushed the moment the number is minted
 * rather than waiting for print and delivery.
 */
export const pushToDigiLocker = task({
  id: "sync.digilocker-push",
  queue: digilockerQueue,
  ttl: TTL.BACKGROUND,
  maxDuration: 120,
  retry: { maxAttempts: 6, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 300_000, randomize: true },
  run: async (payload: { dlNumber: string; citizenId: string; isRenewal: boolean }, { signal }) => {
    const licence = await store.getLicence(payload.dlNumber);
    if (!licence) {
      throw new PermanentValidationError("UNKNOWN_LICENCE", `No local licence ${payload.dlNumber}`);
    }

    // Publishing the same document twice creates a duplicate in the citizen's
    // wallet, which they cannot remove. The claim is cheaper than an apology.
    if ((await store.claimOnce(`digilocker:${payload.dlNumber}:${licence.revision}`)) === "ALREADY_CLAIMED") {
      return { published: false, reason: "already published at this revision" };
    }

    const result = await digiLocker.issueDocument({
      citizenId: payload.citizenId,
      docType: payload.isRenewal ? "DLRNW" : "DRVLC",
      dlNumber: payload.dlNumber,
      pdfStorageKey: `licence-artefacts/${payload.dlNumber}.pdf`,
      signal,
    });

    logger.info("Published to DigiLocker", { dlNumber: payload.dlNumber, uri: result.uri });
    return { published: true, uri: result.uri };
  },
});
