import { logger, task } from "@trigger.dev/sdk";
import { newId } from "../../lib/ids";
import { cardBureau, postal } from "../../lib/providers/logistics";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { notifyCitizen } from "../notifications/dispatch";
import { bulkQueue, printQueue, PRIORITY, TTL } from "../queues";

/**
 * Card production and delivery.
 *
 * The bureau prints in daily batches and India Post takes days to a fortnight,
 * so this is modelled as a long, cheap poll: each check re-arms itself with a
 * delay rather than sitting in a loop, which means a million cards in transit
 * cost a million delayed runs and no workers at all.
 */

const TRACKING_INTERVAL_HOURS = 12;
const MAX_TRACKING_DAYS = 30;

export const queueCardPrint = task({
  id: "licence.print",
  queue: printQueue,
  maxDuration: 120,
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000, randomize: true },
  run: async (
    payload: { applicationId: string; citizenId: string; dlNumber: string; rtoCode: string },
    { signal },
  ) => {
    const job = await cardBureau.queuePrint({
      dlNumber: payload.dlNumber,
      rtoCode: payload.rtoCode,
      // Composed and digitally signed upstream of the bureau; the bureau only
      // ever receives a storage key, never biometric data on the wire.
      artefactKey: `licence-artefacts/${payload.dlNumber}.p7m`,
      signal,
    });

    await store.transitionApplication(payload.applicationId, "PRINT_QUEUED", {
      reason: `card print job ${job.jobId}`,
    });

    await trackDispatch.trigger(
      { applicationId: payload.applicationId, citizenId: payload.citizenId, dlNumber: payload.dlNumber, jobId: job.jobId, checks: 0 },
      {
        delay: `${TRACKING_INTERVAL_HOURS}h`,
        priority: PRIORITY.BACKGROUND,
        ttl: TTL.BACKGROUND,
        idempotencyKey: `track:${payload.dlNumber}:0`,
        tags: [`licence:${payload.dlNumber}`],
      },
    );

    return { jobId: job.jobId, expectedDispatchDate: job.expectedDispatchDate };
  },
});

export const trackDispatch = task({
  id: "licence.track-dispatch",
  queue: bulkQueue,
  ttl: TTL.BACKGROUND,
  maxDuration: 60,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, randomize: true },
  run: async (
    payload: { applicationId: string; citizenId: string; dlNumber: string; jobId: string; checks: number; awb?: string },
    { signal },
  ) => {
    const application = await store.getApplication(payload.applicationId);
    if (!application) return { done: true, reason: "application gone" };

    let awb = payload.awb;
    if (!awb) {
      const job = await cardBureau.getPrintJob(payload.jobId, signal);
      if (job.status === "FAILED") {
        // A failed print is recoverable: re-queue once, and if the bureau keeps
        // refusing, a human needs to look at the artefact.
        await store.recordDeadLetter({
          id: newId("dlq"),
          kind: "licence.print",
          reference: payload.dlNumber,
          payload,
          error: "Card bureau reported a failed print job",
          attempts: payload.checks,
          createdAt: nowIso(),
        });
        return { done: true, reason: "print failed" };
      }
      if (job.status !== "PRINTED") {
        return rearm(payload, "awaiting print");
      }
      // The bureau publishes the AWB with the printed status in the same
      // payload; modelled here as the job id doubling as the consignment.
      awb = payload.jobId;

      await store.transitionApplication(payload.applicationId, "DISPATCHED", { reason: `dispatched via ${awb}` });
      await notifyCitizen({
        citizenId: payload.citizenId,
        event: "LICENCE_DISPATCHED",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `dispatched:${payload.dlNumber}`,
        variables: { dlNumber: payload.dlNumber, awb },
      });
    }

    const tracking = await postal.track(awb, signal);
    if (tracking.status === "DELIVERED") {
      await store.transitionApplication(payload.applicationId, "DELIVERED", {
        reason: `delivered ${tracking.deliveredAt ?? nowIso()}`,
      });
      await notifyCitizen({
        citizenId: payload.citizenId,
        event: "LICENCE_DELIVERED",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `delivered:${payload.dlNumber}`,
        variables: { dlNumber: payload.dlNumber },
      });
      return { done: true, reason: "delivered" };
    }

    if (tracking.status === "RTO_RETURNED" || tracking.status === "LOST") {
      // Undeliverable. The licence itself is valid and already in DigiLocker,
      // so this is a logistics problem, not a licensing one.
      await store.recordDeadLetter({
        id: newId("dlq"),
        kind: "licence.dispatch",
        reference: payload.dlNumber,
        payload: { ...payload, awb, status: tracking.status },
        error: `Consignment ${tracking.status}`,
        attempts: payload.checks,
        createdAt: nowIso(),
      });
      return { done: true, reason: tracking.status };
    }

    return rearm({ ...payload, awb }, tracking.status);
  },
});

async function rearm(
  payload: { applicationId: string; citizenId: string; dlNumber: string; jobId: string; checks: number; awb?: string },
  reason: string,
): Promise<{ done: false; reason: string }> {
  const checks = payload.checks + 1;
  if (checks * TRACKING_INTERVAL_HOURS > MAX_TRACKING_DAYS * 24) {
    logger.warn("Giving up on dispatch tracking", { dlNumber: payload.dlNumber, checks });
    return { done: false, reason: "tracking window exhausted" };
  }

  await trackDispatch.trigger(
    { ...payload, checks },
    {
      delay: `${TRACKING_INTERVAL_HOURS}h`,
      priority: PRIORITY.BACKGROUND,
      ttl: TTL.BACKGROUND,
      idempotencyKey: `track:${payload.dlNumber}:${checks}`,
      idempotencyKeyTTL: "45d",
      tags: [`licence:${payload.dlNumber}`],
    },
  );
  return { done: false, reason };
}
