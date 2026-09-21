import { QuotaExceededError } from "./errors";
import { store } from "./store";

/**
 * Admission control.
 *
 * Queue concurrency (see `src/trigger/queues.ts`) stops one citizen from
 * occupying many workers at once. It does not stop a script from enqueuing a
 * hundred thousand applications that each take a fair turn and collectively
 * bury the country's backlog. These quotas are the second half of that story:
 * they bound how much work one subject may *create* per day, and they are
 * checked at the very top of every citizen-triggered flow so rejected work
 * costs one cheap run instead of a whole pipeline.
 */
export const FAIR_USE = {
  /** A person has at most a handful of legitimate applications in a day. */
  APPLICATIONS_PER_CITIZEN_PER_DAY: 5,
  /** Repeated "pay now" clicks; the gateway order itself is idempotent anyway. */
  PAYMENT_ATTEMPTS_PER_APPLICATION_PER_DAY: 10,
  /** Slot churn: rebooking is allowed, farming scarce slots is not. */
  SLOT_SEARCHES_PER_CITIZEN_PER_DAY: 40,
  /** Hard ceiling on messages to one person, across every event type. */
  SMS_PER_CITIZEN_PER_DAY: 12,
  EMAIL_PER_CITIZEN_PER_DAY: 20,
  /** Burst shape for the above: 3 messages at once, then one every 10 minutes. */
  NOTIFICATION_BURST: 3,
  NOTIFICATION_REFILL_PER_SECOND: 1 / 600,
  /** Document uploads are expensive (OCR + malware scan + face match). */
  DOCUMENT_SCANS_PER_CITIZEN_PER_DAY: 30,
  /** Aadhaar eKYC is metered by UIDAI and misuse is reportable. */
  EKYC_PER_CITIZEN_PER_DAY: 6,
} as const;

/**
 * Consume one unit of a daily allowance or refuse the work outright.
 * Throws QuotaExceededError, which is an AbortTaskRunError, so the run fails
 * once and is not retried into the limit again.
 */
export async function requireDailyQuota(subject: string, name: keyof typeof FAIR_USE): Promise<void> {
  const limit = FAIR_USE[name];
  if (typeof limit !== "number") return;
  const result = await store.consumeDailyQuota(subject, name, limit);
  if (!result.allowed) {
    throw new QuotaExceededError(subject, name, result.retryAfterSeconds);
  }
}

/**
 * Burst-shaped allowance for notifications. Unlike the daily caps this is a
 * soft limit: the caller usually defers the message instead of dropping it.
 */
export async function tryConsumeNotificationToken(citizenId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await store.consumeToken(
    `notify:${citizenId}`,
    FAIR_USE.NOTIFICATION_BURST,
    FAIR_USE.NOTIFICATION_REFILL_PER_SECOND,
  );
  return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
}
