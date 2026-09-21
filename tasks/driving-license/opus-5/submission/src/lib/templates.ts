import type { NotificationCategory, NotificationChannel, NotificationEvent } from "./domain";

/**
 * Message catalogue.
 *
 * Every SMS maps to a DLT-registered template id per language — the aggregator
 * rejects anything else — and the variable *order* is part of that
 * registration, so `variableOrder` is not cosmetic. Adding a language means
 * registering a new template id, not translating a string at runtime.
 */

export type NotificationSpec = {
  category: NotificationCategory;
  channels: NotificationChannel[];
  /** DLT header. Must be one of the registered sender ids for this entity. */
  senderId: string;
  /** Language code -> DLT content template id. `en` is the guaranteed fallback. */
  dltTemplateIds: Record<string, string>;
  emailTemplateKey: string;
  /** Names of the variables, in the order the DLT template expects them. */
  variableOrder: string[];
  /** Repeats of the same event for the same citizen inside this window drop. */
  dedupeWindowSeconds: number;
  /**
   * Higher runs first when the notification queue is saturated. A test reminder
   * an hour before the appointment matters more than a delivery confirmation.
   */
  priority: number;
};

const SENDER_ID = "PRVHAN";

function templates(base: string): Record<string, string> {
  // In production these ids come from the DLT portal export, loaded at build
  // time. The shape is what matters here: one registered id per language.
  return {
    en: `${base}_EN`,
    hi: `${base}_HI`,
    ta: `${base}_TA`,
    te: `${base}_TE`,
    bn: `${base}_BN`,
    mr: `${base}_MR`,
  };
}

export const NOTIFICATION_SPECS: Record<NotificationEvent, NotificationSpec> = {
  APPLICATION_SUBMITTED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000001"),
    emailTemplateKey: "application-submitted",
    variableOrder: ["applicationId", "service"],
    dedupeWindowSeconds: 86_400,
    priority: 20,
  },
  KYC_FAILED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000002"),
    emailTemplateKey: "kyc-failed",
    variableOrder: ["applicationId", "reason"],
    dedupeWindowSeconds: 86_400,
    priority: 30,
  },
  DOCS_REJECTED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000003"),
    emailTemplateKey: "documents-rejected",
    variableOrder: ["applicationId", "reason"],
    dedupeWindowSeconds: 21_600,
    priority: 30,
  },
  FEE_DUE: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000004"),
    emailTemplateKey: "fee-due",
    variableOrder: ["applicationId", "amount", "expiresAt"],
    dedupeWindowSeconds: 3_600,
    priority: 40,
  },
  PAYMENT_SUCCESS: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000005"),
    emailTemplateKey: "payment-receipt",
    variableOrder: ["applicationId", "amount", "paymentId"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  PAYMENT_FAILED: {
    category: "TRANSACTIONAL",
    channels: ["SMS"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000006"),
    emailTemplateKey: "payment-failed",
    variableOrder: ["applicationId", "amount"],
    dedupeWindowSeconds: 1_800,
    priority: 40,
  },
  PAYMENT_REFUNDED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000007"),
    emailTemplateKey: "payment-refunded",
    variableOrder: ["applicationId", "amount", "refundId"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  SLOT_BOOKED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000008"),
    emailTemplateKey: "slot-booked",
    variableOrder: ["applicationId", "slotTime", "rtoCode"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  SLOT_REMINDER: {
    category: "SERVICE",
    channels: ["SMS", "PUSH"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000009"),
    emailTemplateKey: "slot-reminder",
    variableOrder: ["slotTime", "rtoCode"],
    dedupeWindowSeconds: 43_200,
    priority: 60,
  },
  TEST_PASSED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000010"),
    emailTemplateKey: "test-passed",
    variableOrder: ["applicationId", "testKind"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  TEST_FAILED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000011"),
    emailTemplateKey: "test-failed",
    variableOrder: ["applicationId", "retakeAfter"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  LICENCE_ISSUED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000012"),
    emailTemplateKey: "licence-issued",
    variableOrder: ["dlNumber", "validTill"],
    dedupeWindowSeconds: 86_400,
    priority: 50,
  },
  LICENCE_DISPATCHED: {
    category: "SERVICE",
    channels: ["SMS"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000013"),
    emailTemplateKey: "licence-dispatched",
    variableOrder: ["dlNumber", "awb"],
    dedupeWindowSeconds: 86_400,
    priority: 20,
  },
  LICENCE_DELIVERED: {
    category: "SERVICE",
    channels: ["SMS"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000014"),
    emailTemplateKey: "licence-delivered",
    variableOrder: ["dlNumber"],
    dedupeWindowSeconds: 86_400,
    priority: 10,
  },
  LICENCE_EXPIRING: {
    category: "SERVICE",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000015"),
    emailTemplateKey: "licence-expiring",
    variableOrder: ["dlNumber", "validTill"],
    // One reminder per day at most, however many sweeps touch the licence.
    dedupeWindowSeconds: 86_400,
    priority: 5,
  },
  APPLICATION_EXPIRED: {
    category: "TRANSACTIONAL",
    channels: ["SMS", "EMAIL"],
    senderId: SENDER_ID,
    dltTemplateIds: templates("1107160000016"),
    emailTemplateKey: "application-expired",
    variableOrder: ["applicationId"],
    dedupeWindowSeconds: 86_400,
    priority: 20,
  },
};

export function resolveTemplateId(spec: NotificationSpec, language: string): string {
  return spec.dltTemplateIds[language] ?? spec.dltTemplateIds.en ?? "";
}

/** Orders the caller's variables the way the registered template expects. */
export function orderVariables(spec: NotificationSpec, variables: Record<string, string>): string[] {
  return spec.variableOrder.map((name) => variables[name] ?? "");
}
