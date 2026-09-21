import { queue } from "@trigger.dev/sdk";

/**
 * Capacity policy for the whole portal.
 *
 * At national scale the failure mode is never "one task is slow", it is "one
 * subject eats the pool". Two different mechanisms are needed, and mixing them
 * up is the usual mistake, so they are kept visibly separate here.
 *
 * FAIRNESS QUEUES have a deliberately tiny concurrency limit and are *always*
 * triggered with a `concurrencyKey`. Trigger.dev gives every distinct key its
 * own copy of the queue with that same limit, so `limit: 1` keyed on citizen id
 * means one citizen gets one worker at a time while a million other citizens
 * proceed in parallel. This is what makes a scripted flood self-limiting: the
 * attacker's thousandth submission waits behind their own first one.
 *
 * CAPACITY QUEUES have a large limit, no concurrency key, and exist to protect
 * something downstream — UIDAI's eKYC quota, the payment gateway's connection
 * pool, the SMS aggregator's TPS. They are the bulkhead: because bulk sync work
 * sits on its own small queue, a ten-million-row delta import cannot starve the
 * citizen-facing pipeline no matter how far behind it falls.
 *
 * The environment-wide concurrency ceiling still applies on top of both. The
 * limits below are sized so the sum of the interactive queues stays under it
 * with headroom, and every non-interactive queue is small on purpose.
 */

// ---------------------------------------------------------------- fairness

/**
 * One in-flight application pipeline per citizen. Everything a citizen can
 * trigger from the portal funnels through here.
 */
export const citizenPipelineQueue = queue({
  name: "citizen-pipeline",
  concurrencyLimit: 1,
});

/** One in-flight money operation per application. Never raise this above 1. */
export const applicationPaymentQueue = queue({
  name: "application-payment",
  concurrencyLimit: 1,
});

/**
 * Notification fan-out per citizen. Two, so a genuinely multi-channel event
 * (SMS + email) dispatches together without one blocking the other.
 */
export const citizenNotificationQueue = queue({
  name: "citizen-notification",
  concurrencyLimit: 2,
});

/**
 * Slot inventory is contended per RTO, not per citizen. Keyed on the RTO code
 * so Delhi's volume cannot crowd out a district office, and capped low because
 * seat allocation is a write-heavy critical section.
 */
export const rtoSlotQueue = queue({
  name: "rto-slot",
  concurrencyLimit: 4,
});

// ---------------------------------------------------------------- capacity

/** UIDAI meters eKYC per AUA; exceeding the contract is a compliance issue. */
export const ekycQueue = queue({
  name: "ekyc",
  concurrencyLimit: 150,
});

/** OCR, malware scan and face match. CPU-bound upstream, sized to its fleet. */
export const documentQueue = queue({
  name: "document-verification",
  concurrencyLimit: 300,
});

/** Payment gateway connection pool. Shared by orders, polls and refunds. */
export const gatewayQueue = queue({
  name: "payment-gateway",
  concurrencyLimit: 200,
});

/** Aggregator TPS ceiling. The single largest consumer during a sweep. */
export const smsQueue = queue({
  name: "sms-delivery",
  concurrencyLimit: 400,
});

export const emailQueue = queue({
  name: "email-delivery",
  concurrencyLimit: 200,
});

/** Sarathi National Register writes. It is slow and rate limits aggressively. */
export const nationalRegisterQueue = queue({
  name: "national-register",
  concurrencyLimit: 60,
});

export const enforcementQueue = queue({
  name: "vahan-enforcement",
  concurrencyLimit: 40,
});

export const digilockerQueue = queue({
  name: "digilocker",
  concurrencyLimit: 40,
});

export const printQueue = queue({
  name: "card-print",
  concurrencyLimit: 50,
});

/**
 * Everything scheduled, swept or replayed. Small on purpose: background work is
 * allowed to take all night, but it is never allowed to make a citizen wait.
 */
export const bulkQueue = queue({
  name: "bulk-batch",
  concurrencyLimit: 25,
});

/** Money reconciliation. Serialised per shard so two sweeps cannot double-refund. */
export const reconciliationQueue = queue({
  name: "reconciliation",
  concurrencyLimit: 8,
});

/**
 * Run priorities. The value is a dequeue time offset in seconds, so a run with
 * priority 120 jumps ahead of anything queued in the last two minutes at
 * priority 0. Interactive work is positive, background work is zero: background
 * runs are never given a head start over a waiting citizen.
 */
export const PRIORITY = {
  /** Somebody is staring at a spinner. */
  INTERACTIVE: 120,
  /** Money is in flight and the citizen is mid-checkout. */
  PAYMENT: 180,
  /** An appointment is imminent. */
  TIME_CRITICAL: 240,
  STANDARD: 30,
  BACKGROUND: 0,
} as const;

/**
 * Time-to-live. Work that has lost its meaning must leave the queue rather than
 * be processed late — a reminder for an appointment that already happened is
 * worse than no reminder, and shedding it is how the system degrades gracefully
 * instead of collapsing under a backlog.
 */
export const TTL = {
  INTERACTIVE: "15m",
  NOTIFICATION: "6h",
  REMINDER: "1h",
  BACKGROUND: "24h",
} as const;
