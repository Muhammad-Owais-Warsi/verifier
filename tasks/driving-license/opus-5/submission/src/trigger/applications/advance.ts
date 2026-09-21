import { logger, task } from "@trigger.dev/sdk";
import { LL_TO_DL_MIN_DAYS } from "../../lib/eligibility";
import { PermanentValidationError } from "../../lib/errors";
import { requiresTest } from "../../lib/fees";
import { isTerminal } from "../../lib/state-machine";
import { store } from "../../lib/store";
import { addDays } from "../../lib/time";
import { issueLicence } from "../issuance/issue";
import { citizenPipelineQueue, PRIORITY, TTL } from "../queues";
import { bookSlot } from "../slots/book";

/**
 * What happens once the fee has actually settled.
 *
 * Split out from `application.submit` because there are three ways to arrive
 * here — the happy path, a settlement that resolved after the checkout run
 * ended, and an officer releasing a held application — and all three must
 * produce the same behaviour. It reads the application fresh and is safe to
 * run twice.
 */

const SLOT_RETRY_HOURS = 6;
const MAX_SLOT_RETRIES = 8;

export type AdvanceOutcome = {
  outcome: "TEST_SCHEDULED" | "WAITING_FOR_SLOT" | "ISSUING" | "ALREADY_ADVANCED" | "CLOSED";
  slotId?: string;
};

export const advanceAfterFee = task({
  id: "application.advance-after-fee",
  queue: citizenPipelineQueue,
  maxDuration: 300,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload: { applicationId: string; citizenId: string; slotAttempt?: number }): Promise<AdvanceOutcome> => {
    const application = await store.getApplication(payload.applicationId);
    if (!application) {
      throw new PermanentValidationError("UNKNOWN_APPLICATION", `No application ${payload.applicationId}`);
    }
    if (isTerminal(application.status)) {
      return { outcome: "CLOSED" };
    }
    if (application.status !== "FEE_PAID" && application.status !== "SLOT_PENDING") {
      // Something already moved this forward — a retry, or the officer flow.
      return { outcome: "ALREADY_ADVANCED" };
    }

    if (!requiresTest(application.service)) {
      // Renewals, duplicates and particulars changes go straight to the
      // officer's desk; issuance is triggered from there.
      await store.transitionApplication(application.id, "RTO_REVIEW", { reason: "no test required" });
      await issueLicence.trigger(
        {
          applicationId: application.id,
          citizenId: payload.citizenId,
          rtoCode: application.rtoCode,
          covs: application.covs,
          service: application.service,
        },
        {
          concurrencyKey: payload.citizenId,
          priority: PRIORITY.STANDARD,
          ttl: TTL.BACKGROUND,
          idempotencyKey: `issue:${application.id}`,
          idempotencyKeyTTL: "30d",
          tags: [`application:${application.id}`],
        },
      );
      return { outcome: "ISSUING" };
    }

    await store.transitionApplication(application.id, "SLOT_PENDING", { reason: "ready to book a test" });

    // A permanent licence test cannot be taken until the learner's licence is
    // thirty days old.
    const notBefore =
      application.service === "DL_NEW" || application.service === "DL_ADD_COV"
        ? addDays(new Date(application.createdAt), LL_TO_DL_MIN_DAYS).toISOString()
        : new Date().toISOString();

    const booking = await bookSlot
      .triggerAndWait(
        {
          applicationId: application.id,
          citizenId: payload.citizenId,
          rtoCode: application.rtoCode,
          kind: application.service.startsWith("LL_") ? "LL_TEST" : "DRIVING_TEST",
          notBefore,
        },
        {
          // Keyed on the RTO, not the citizen: contention here is for that
          // office's seats.
          concurrencyKey: application.rtoCode,
          priority: PRIORITY.INTERACTIVE,
          ttl: TTL.INTERACTIVE,
          tags: [`application:${application.id}`, `rto:${application.rtoCode}`],
        },
      )
      .unwrap();

    if (booking.outcome === "NO_SLOTS") {
      const attempt = (payload.slotAttempt ?? 0) + 1;
      if (attempt > MAX_SLOT_RETRIES) {
        // Two days of no seats is an RTO capacity problem, not a citizen
        // problem. Park it; the stale-application sweep will refund if it
        // never resolves.
        await store.transitionApplication(application.id, "ON_HOLD", { reason: "no test slots available" });
        logger.warn("Gave up searching for a slot", { applicationId: application.id, rtoCode: application.rtoCode });
        return { outcome: "WAITING_FOR_SLOT" };
      }
      await advanceAfterFee.trigger(
        { ...payload, slotAttempt: attempt },
        {
          concurrencyKey: payload.citizenId,
          delay: `${SLOT_RETRY_HOURS}h`,
          priority: PRIORITY.STANDARD,
          ttl: TTL.BACKGROUND,
          tags: [`application:${application.id}`],
        },
      );
      return { outcome: "WAITING_FOR_SLOT" };
    }

    if (booking.outcome === "BOOKED") {
      await store.transitionApplication(application.id, "SLOT_BOOKED", {
        reason: `slot ${booking.slotId} at ${booking.startsAt}`,
        patch: { slotId: booking.slotId },
      });
    }

    await store.transitionApplication(application.id, "TEST_SCHEDULED", { reason: "awaiting test result" });
    return { outcome: "TEST_SCHEDULED", slotId: application.slotId };
  },
});
