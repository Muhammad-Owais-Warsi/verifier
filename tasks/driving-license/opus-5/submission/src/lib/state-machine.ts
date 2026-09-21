import type { ApplicationStatus } from "./domain";
import { TERMINAL_STATUSES } from "./domain";

/**
 * The single source of truth for application lifecycle. Every writer goes
 * through `assertTransition`, which is what makes duplicate webhooks and
 * out-of-order external callbacks harmless: an event that would move the
 * application backwards is rejected instead of corrupting state.
 */
const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED", "EXPIRED"],
  // Eligibility is checked before KYC, so a statutory rejection can happen
  // before the application has moved anywhere else.
  SUBMITTED: ["KYC_PENDING", "REJECTED", "CANCELLED", "EXPIRED"],
  KYC_PENDING: ["DOCS_PENDING", "KYC_FAILED", "REJECTED", "ON_HOLD", "CANCELLED", "EXPIRED"],
  KYC_FAILED: [],
  DOCS_PENDING: ["FEE_PENDING", "DOCS_REJECTED", "REJECTED", "ON_HOLD", "CANCELLED", "EXPIRED"],
  DOCS_REJECTED: ["DOCS_PENDING", "CANCELLED", "EXPIRED"],
  FEE_PENDING: ["FEE_PAID", "CANCELLED", "EXPIRED"],
  FEE_PAID: ["SLOT_PENDING", "RTO_REVIEW", "ON_HOLD", "CANCELLED"],
  SLOT_PENDING: ["SLOT_BOOKED", "ON_HOLD", "CANCELLED", "EXPIRED"],
  SLOT_BOOKED: ["TEST_SCHEDULED", "SLOT_PENDING", "CANCELLED", "EXPIRED"],
  TEST_SCHEDULED: ["TEST_PASSED", "TEST_FAILED", "SLOT_PENDING", "CANCELLED", "EXPIRED"],
  TEST_PASSED: ["RTO_REVIEW", "APPROVED", "ON_HOLD"],
  // A failed test does not kill the application: the citizen re-books after the
  // mandatory cooling-off period, paying the retest fee.
  TEST_FAILED: ["FEE_PENDING", "SLOT_PENDING", "EXPIRED", "CANCELLED"],
  RTO_REVIEW: ["APPROVED", "REJECTED", "ON_HOLD", "DOCS_REJECTED"],
  APPROVED: ["PRINT_QUEUED", "ON_HOLD"],
  REJECTED: [],
  PRINT_QUEUED: ["DISPATCHED", "ON_HOLD"],
  DISPATCHED: ["DELIVERED", "ON_HOLD"],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
  // ON_HOLD is where a human parks an application; only a human takes it out.
  ON_HOLD: [
    "DOCS_PENDING",
    "FEE_PENDING",
    "SLOT_PENDING",
    "RTO_REVIEW",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
  ],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * True when the target state has already been reached. Lets idempotent handlers
 * distinguish "this is a replay, ignore it" from "this is genuinely illegal".
 */
export function isReplay(current: ApplicationStatus, to: ApplicationStatus): boolean {
  return current === to;
}

/** States in which money has been taken and would have to be refunded. */
export function hasPaidFee(status: ApplicationStatus): boolean {
  const paidStates: ApplicationStatus[] = [
    "FEE_PAID",
    "SLOT_PENDING",
    "SLOT_BOOKED",
    "TEST_SCHEDULED",
    "TEST_PASSED",
    "TEST_FAILED",
    "RTO_REVIEW",
    "APPROVED",
    "PRINT_QUEUED",
    "DISPATCHED",
    "DELIVERED",
  ];
  return paidStates.includes(status);
}
