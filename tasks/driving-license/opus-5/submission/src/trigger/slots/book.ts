import { logger, schemaTask, task } from "@trigger.dev/sdk";
import { requireDailyQuota } from "../../lib/fair-use";
import { stableKey } from "../../lib/ids";
import { bookSlotSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { isRtoWorkingDay, nowIso } from "../../lib/time";
import { notifyCitizen } from "../notifications/dispatch";
import { bulkQueue, PRIORITY, rtoSlotQueue, TTL } from "../queues";

/**
 * Test appointment booking.
 *
 * Seats are the one genuinely scarce resource in the system: an RTO has a fixed
 * number of test slots per day and they are contended by everyone in that
 * district at once. Fairness here is keyed on the RTO rather than the citizen,
 * because the contention is on the RTO's inventory — and capped low, because
 * allocating a seat is a short critical section that must not be run wide.
 *
 * Booking is hold-then-confirm even though both halves happen in this run. The
 * hold is what makes a crash safe: an unconfirmed hold expires and the seat
 * returns to the pool, rather than being lost to a half-finished booking.
 */

const HOLD_MINUTES = 15;
const REMINDER_LEAD_HOURS = [24, 2];

export type BookingOutcome =
  | { outcome: "BOOKED"; slotId: string; startsAt: string }
  | { outcome: "NO_SLOTS" }
  | { outcome: "ALREADY_BOOKED"; slotId: string };

export const bookSlot = schemaTask({
  id: "slot.book",
  schema: bookSlotSchema,
  queue: rtoSlotQueue,
  maxDuration: 120,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 20_000, randomize: true },
  run: async (payload): Promise<BookingOutcome> => {
    await requireDailyQuota(payload.citizenId, "SLOT_SEARCHES_PER_CITIZEN_PER_DAY");

    const application = await store.getApplication(payload.applicationId);
    if (application?.slotId) {
      return { outcome: "ALREADY_BOOKED", slotId: application.slotId };
    }

    const candidates = (await store.listOpenSlots(payload.rtoCode, payload.kind, payload.notBefore)).filter((slot) =>
      isRtoWorkingDay(new Date(slot.startsAt)),
    );

    const ordered = payload.preferredSlotId
      ? [...candidates].sort((a, b) => (a.id === payload.preferredSlotId ? -1 : b.id === payload.preferredSlotId ? 1 : 0))
      : candidates;

    for (const slot of ordered) {
      // Deterministic hold id: a retry of this run reuses the same hold instead
      // of consuming a second seat.
      const holdId = stableKey("hold", payload.applicationId, slot.id);
      const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
      const hold = await store.holdSlot({
        holdId,
        slotId: slot.id,
        applicationId: payload.applicationId,
        citizenId: payload.citizenId,
        expiresAt,
      });

      // Somebody else took the last seat between the read and the write. Next.
      if (!hold) continue;

      await store.confirmHold(hold.id);
      await store.patchApplication(payload.applicationId, { slotId: slot.id });

      if (application) {
        await notifyCitizen({
          citizenId: payload.citizenId,
          event: "SLOT_BOOKED",
          mobile: application.applicant.mobile,
          email: application.applicant.email,
          language: application.applicant.language,
          dedupeKey: `slot-booked:${payload.applicationId}:${slot.id}`,
          variables: { applicationId: payload.applicationId, slotTime: slot.startsAt, rtoCode: payload.rtoCode },
        });
      }

      await scheduleReminders(payload.applicationId, payload.citizenId, slot.id, slot.startsAt);
      logger.info("Slot booked", { applicationId: payload.applicationId, slotId: slot.id, startsAt: slot.startsAt });
      return { outcome: "BOOKED", slotId: slot.id, startsAt: slot.startsAt };
    }

    logger.info("No slots available", { rtoCode: payload.rtoCode, kind: payload.kind, notBefore: payload.notBefore });
    return { outcome: "NO_SLOTS" };
  },
});

async function scheduleReminders(
  applicationId: string,
  citizenId: string,
  slotId: string,
  startsAt: string,
): Promise<void> {
  for (const leadHours of REMINDER_LEAD_HOURS) {
    const fireAt = new Date(new Date(startsAt).getTime() - leadHours * 3_600_000);
    if (fireAt.getTime() <= Date.now()) continue;
    await sendSlotReminder.trigger(
      { applicationId, citizenId, slotId, leadHours },
      {
        delay: fireAt,
        // A reminder that missed its window is worse than no reminder, so it
        // expires out of the queue instead of arriving after the appointment.
        ttl: TTL.REMINDER,
        priority: PRIORITY.TIME_CRITICAL,
        idempotencyKey: stableKey("reminder", applicationId, slotId, leadHours),
        idempotencyKeyTTL: "30d",
        tags: [`application:${applicationId}`, `citizen:${citizenId}`],
      },
    );
  }
}

export const sendSlotReminder = task({
  id: "slot.reminder",
  queue: bulkQueue,
  maxDuration: 30,
  retry: { maxAttempts: 2 },
  run: async (payload: { applicationId: string; citizenId: string; slotId: string; leadHours: number }) => {
    const application = await store.getApplication(payload.applicationId);
    const slot = await store.getSlot(payload.slotId);

    // The appointment may have been rescheduled, cancelled or already taken
    // since this was queued days ago.
    if (!application || !slot || application.slotId !== payload.slotId || application.status !== "TEST_SCHEDULED") {
      logger.info("Skipping stale reminder", { applicationId: payload.applicationId, slotId: payload.slotId });
      return { sent: false };
    }
    if (new Date(slot.startsAt).getTime() < Date.now()) {
      return { sent: false };
    }

    await notifyCitizen({
      citizenId: payload.citizenId,
      event: "SLOT_REMINDER",
      mobile: application.applicant.mobile,
      email: application.applicant.email,
      language: application.applicant.language,
      dedupeKey: `slot-reminder:${payload.slotId}:${payload.leadHours}`,
      variables: { slotTime: slot.startsAt, rtoCode: slot.rtoCode },
    });
    return { sent: true, at: nowIso() };
  },
});
