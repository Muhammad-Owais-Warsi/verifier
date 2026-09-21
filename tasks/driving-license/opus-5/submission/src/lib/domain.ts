/**
 * Domain vocabulary for the licensing portal. Mirrors the Sarathi service
 * catalogue: a citizen holds at most one learner's licence and one driving
 * licence per state, and every change to either is modelled as an application.
 */

export const SERVICES = [
  "LL_NEW",
  "LL_DUPLICATE",
  "LL_ADD_COV",
  "DL_NEW",
  "DL_RENEWAL",
  "DL_DUPLICATE",
  "DL_ADD_COV",
  "DL_CHANGE_ADDRESS",
  "DL_CHANGE_NAME",
  "DL_IDP",
  "DL_SURRENDER_COV",
] as const;
export type Service = (typeof SERVICES)[number];

/** Class of vehicle, using the RTO codes printed on the licence. */
export const COVS = [
  "MCWOG",
  "MCWG",
  "MC50CC",
  "LMV",
  "LMV_NT",
  "LMV_TR",
  "TRANS",
  "HGMV",
  "HPMV",
  "HTV",
  "TRC",
  "ERIKSH",
] as const;
export type Cov = (typeof COVS)[number];

/** Classes that are only issued after a commercial/transport driving test. */
export const TRANSPORT_COVS: readonly Cov[] = ["LMV_TR", "TRANS", "HGMV", "HPMV", "HTV", "TRC"];

export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "KYC_PENDING",
  "KYC_FAILED",
  "DOCS_PENDING",
  "DOCS_REJECTED",
  "FEE_PENDING",
  "FEE_PAID",
  "SLOT_PENDING",
  "SLOT_BOOKED",
  "TEST_SCHEDULED",
  "TEST_PASSED",
  "TEST_FAILED",
  "RTO_REVIEW",
  "APPROVED",
  "REJECTED",
  "PRINT_QUEUED",
  "DISPATCHED",
  "DELIVERED",
  "CANCELLED",
  "EXPIRED",
  "ON_HOLD",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Statuses from which nothing further happens automatically. */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  "DELIVERED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "KYC_FAILED",
];

export type DocumentKind =
  | "AADHAAR"
  | "PAN"
  | "PASSPORT_PHOTO"
  | "SIGNATURE"
  | "AGE_PROOF"
  | "ADDRESS_PROOF"
  | "FORM_1"
  | "FORM_1A_MEDICAL"
  | "FORM_5_DRIVING_SCHOOL"
  | "EXISTING_LICENCE"
  | "NOC";

export type ApplicantDocument = {
  kind: DocumentKind;
  /** Object key in the document store, never the raw bytes. */
  storageKey: string;
  sha256: string;
  uploadedAt: string;
};

export type Applicant = {
  citizenId: string;
  fullName: string;
  dateOfBirth: string;
  /** Last four digits only; the full number never leaves the KYC boundary. */
  aadhaarLast4: string;
  mobile: string;
  email?: string;
  /** ISO 639-1 code used to pick the notification template. */
  language: string;
  state: string;
  rtoCode: string;
  /** Set for any application that touches an existing licence. */
  existingDlNumber?: string;
};

export type Application = {
  id: string;
  service: Service;
  status: ApplicationStatus;
  applicant: Applicant;
  covs: Cov[];
  documents: ApplicantDocument[];
  rtoCode: string;
  /** Optimistic concurrency guard; every write bumps it. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Free-form audit trail of every status change. */
  history: Array<{ at: string; from: ApplicationStatus; to: ApplicationStatus; reason: string }>;
  paymentId?: string;
  slotId?: string;
  licenceNumber?: string;
  rejectionReason?: string;
};

export type PaymentStatus =
  | "CREATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "EXPIRED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REFUND_FAILED"
  | "PENDING_RECONCILIATION";

export type FeeLine = {
  head: string;
  /** Paise, never rupees — no floating point money anywhere in this codebase. */
  amountPaise: number;
};

export type FeePurpose = "APPLICATION" | "RETEST" | "DELIVERY";

export type Payment = {
  id: string;
  applicationId: string;
  citizenId: string;
  purpose: FeePurpose;
  status: PaymentStatus;
  lines: FeeLine[];
  amountPaise: number;
  /** Set once the gateway acknowledges the order. */
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  capturedAmountPaise?: number;
  refundedAmountPaise?: number;
  refundId?: string;
  failureReason?: string;
  /** Waitpoint the settlement listener completes; lets a webhook resume the run. */
  waitTokenId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type SlotStatus = "OPEN" | "HELD" | "BOOKED" | "RELEASED" | "CONSUMED";

export type Slot = {
  id: string;
  rtoCode: string;
  kind: "LL_TEST" | "DRIVING_TEST" | "BIOMETRIC";
  /** Start of the appointment in ISO-8601 with IST offset. */
  startsAt: string;
  capacity: number;
  booked: number;
  status: SlotStatus;
};

export type SlotHold = {
  id: string;
  slotId: string;
  applicationId: string;
  citizenId: string;
  expiresAt: string;
  released: boolean;
};

export type Licence = {
  number: string;
  citizenId: string;
  rtoCode: string;
  covs: Cov[];
  issuedAt: string;
  validTill: string;
  /** Transport endorsements expire earlier than the licence itself. */
  transportValidTill?: string;
  status: "ACTIVE" | "SUSPENDED" | "DISQUALIFIED" | "EXPIRED" | "SURRENDERED";
  /** Bumped on every mutation so the National Register can resolve conflicts. */
  revision: number;
  updatedAt: string;
};

export type NotificationChannel = "SMS" | "EMAIL" | "PUSH";

/**
 * Transactional messages are legally required updates and bypass quiet hours and
 * DND. Service messages are useful but deferrable. Promotional messages are not
 * sent by this system at all, but the category exists so the throttles can
 * reject them loudly if somebody adds one.
 */
export type NotificationCategory = "TRANSACTIONAL" | "SERVICE" | "PROMOTIONAL";

export type NotificationEvent =
  | "APPLICATION_SUBMITTED"
  | "KYC_FAILED"
  | "DOCS_REJECTED"
  | "FEE_DUE"
  | "PAYMENT_SUCCESS"
  | "PAYMENT_FAILED"
  | "PAYMENT_REFUNDED"
  | "SLOT_BOOKED"
  | "SLOT_REMINDER"
  | "TEST_PASSED"
  | "TEST_FAILED"
  | "LICENCE_ISSUED"
  | "LICENCE_DISPATCHED"
  | "LICENCE_DELIVERED"
  | "LICENCE_EXPIRING"
  | "APPLICATION_EXPIRED";

export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "SUPPRESSED" | "UNKNOWN";
