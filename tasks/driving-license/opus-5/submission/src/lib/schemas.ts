import { z } from "zod";
import { COVS, SERVICES } from "./domain";

/**
 * Payload contracts. These are attached to the tasks with `schemaTask`, so a
 * malformed trigger from a portal deploy fails at the boundary with a readable
 * error instead of halfway through a money-moving flow.
 */

export const applicantSchema = z.object({
  citizenId: z.string().min(1),
  fullName: z.string().min(1).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  aadhaarLast4: z.string().regex(/^\d{4}$/),
  mobile: z.string().regex(/^[6-9]\d{9}$/, "expected a 10-digit Indian mobile number"),
  email: z.string().email().optional(),
  language: z.string().min(2).max(5).default("en"),
  state: z.string().length(2),
  rtoCode: z.string().min(4).max(6),
  existingDlNumber: z.string().optional(),
});

export const documentSchema = z.object({
  kind: z.enum([
    "AADHAAR",
    "PAN",
    "PASSPORT_PHOTO",
    "SIGNATURE",
    "AGE_PROOF",
    "ADDRESS_PROOF",
    "FORM_1",
    "FORM_1A_MEDICAL",
    "FORM_5_DRIVING_SCHOOL",
    "EXISTING_LICENCE",
    "NOC",
  ]),
  storageKey: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: z.string(),
});

export const submitApplicationSchema = z.object({
  applicationId: z.string().min(1),
  service: z.enum(SERVICES),
  applicant: applicantSchema,
  covs: z.array(z.enum(COVS)).min(1).max(6),
  documents: z.array(documentSchema).max(15),
  /** Short-lived UIDAI reference; the raw Aadhaar number never reaches us. */
  ekycReferenceToken: z.string().min(1),
  deliverByPost: z.boolean().default(true),
  /** Set by the portal so a double-submit from two tabs collapses to one run. */
  submissionNonce: z.string().min(1),
});
export type SubmitApplication = z.infer<typeof submitApplicationSchema>;

export const collectFeeSchema = z.object({
  applicationId: z.string().min(1),
  citizenId: z.string().min(1),
  service: z.enum(SERVICES),
  covs: z.array(z.enum(COVS)),
  previousValidTill: z.string().optional(),
  testAttempt: z.number().int().min(1).default(1),
  deliverByPost: z.boolean().default(true),
  /** Distinguishes the application fee from a later retest fee. */
  feePurpose: z.enum(["APPLICATION", "RETEST", "DELIVERY"]).default("APPLICATION"),
});
export type CollectFee = z.infer<typeof collectFeeSchema>;

export const gatewayWebhookSchema = z.object({
  /** Raw body exactly as received; the signature is computed over this. */
  rawBody: z.string().min(1),
  signature: z.string().min(1),
  receivedAt: z.string(),
});

export const gatewayEventSchema = z.object({
  eventId: z.string().min(1),
  event: z.enum([
    "payment.authorized",
    "payment.captured",
    "payment.failed",
    "order.expired",
    "refund.processed",
    "refund.failed",
  ]),
  orderId: z.string().min(1),
  paymentId: z.string().optional(),
  amountPaise: z.number().int().nonnegative(),
  refundId: z.string().optional(),
  failureCode: z.string().optional(),
  createdAt: z.string(),
});
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;

export const notificationRequestSchema = z.object({
  citizenId: z.string().min(1),
  event: z.enum([
    "APPLICATION_SUBMITTED",
    "KYC_FAILED",
    "DOCS_REJECTED",
    "FEE_DUE",
    "PAYMENT_SUCCESS",
    "PAYMENT_FAILED",
    "PAYMENT_REFUNDED",
    "SLOT_BOOKED",
    "SLOT_REMINDER",
    "TEST_PASSED",
    "TEST_FAILED",
    "LICENCE_ISSUED",
    "LICENCE_DISPATCHED",
    "LICENCE_DELIVERED",
    "LICENCE_EXPIRING",
    "APPLICATION_EXPIRED",
  ]),
  mobile: z.string().regex(/^[6-9]\d{9}$/),
  email: z.string().email().optional(),
  language: z.string().default("en"),
  variables: z.record(z.string(), z.string()).default({}),
  /**
   * Caller-supplied identity of the message. Two triggers with the same key are
   * the same message, whatever path they arrived by.
   */
  dedupeKey: z.string().min(1),
  /** Skips the quiet-hours deferral. Only for genuinely time-critical alerts. */
  bypassQuietHours: z.boolean().default(false),
  /** Incremented each time the throttle pushes this message out; bounded. */
  deferralCount: z.number().int().min(0).default(0),
});
export type NotificationRequest = z.infer<typeof notificationRequestSchema>;

export const bookSlotSchema = z.object({
  applicationId: z.string().min(1),
  citizenId: z.string().min(1),
  rtoCode: z.string().min(4),
  kind: z.enum(["LL_TEST", "DRIVING_TEST", "BIOMETRIC"]),
  /** Earliest acceptable date, e.g. LL + 30 days for a permanent licence. */
  notBefore: z.string(),
  preferredSlotId: z.string().optional(),
});

export const testResultSchema = z.object({
  applicationId: z.string().min(1),
  citizenId: z.string().min(1),
  kind: z.enum(["LL_TEST", "DRIVING_TEST"]),
  passed: z.boolean(),
  score: z.number().int().min(0).max(100).optional(),
  /** Inspector id for a driving test, "SYSTEM" for the online LL test. */
  examinerId: z.string().min(1),
  remarks: z.string().max(500).optional(),
  conductedAt: z.string(),
});

export const issueLicenceSchema = z.object({
  applicationId: z.string().min(1),
  citizenId: z.string().min(1),
  rtoCode: z.string().min(4),
  covs: z.array(z.enum(COVS)).min(1),
  service: z.enum(SERVICES),
  deliverByPost: z.boolean().default(true),
});

export const refundSchema = z.object({
  paymentId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  reason: z.enum([
    "DUPLICATE_PAYMENT",
    "OVERPAYMENT",
    "APPLICATION_CANCELLED",
    "APPLICATION_REJECTED",
    "SLOT_UNAVAILABLE",
    "LATE_SETTLEMENT",
    "SERVICE_FAILURE",
  ]),
  /** Set when the refund is a compensating action for an orphaned capture. */
  orphaned: z.boolean().default(false),
});
export type RefundRequest = z.infer<typeof refundSchema>;
export type RefundReason = RefundRequest["reason"];
