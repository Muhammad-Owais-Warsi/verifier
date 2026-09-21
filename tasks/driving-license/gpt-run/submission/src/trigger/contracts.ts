export type ApplicationStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PAYMENT_PENDING"
  | "PAID"
  | "SCRUTINY"
  | "TEST_SCHEDULED"
  | "APPROVED"
  | "REJECTED"
  | "LICENSE_ISSUED";

export interface ApplicationEvent {
  eventId: string;
  applicationId: string;
  userId: string;
  stateCode: string;
  status: ApplicationStatus;
  occurredAt: string;
  version: number;
}

export interface PaymentEvent {
  eventId: string;
  paymentId: string;
  applicationId: string;
  userId: string;
  amountPaise: number;
  provider: string;
  providerReference: string;
  status: "INITIATED" | "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";
  occurredAt: string;
}

export interface NotificationRequest {
  notificationId: string;
  userId: string;
  applicationId?: string;
  template:
    | "APPLICATION_UPDATE"
    | "PAYMENT_RECEIPT"
    | "PAYMENT_FAILED"
    | "TEST_REMINDER"
    | "LICENSE_ISSUED";
  channels: Array<"email" | "sms">;
  locale?: string;
  variables: Record<string, string>;
}

export interface SyncRequest {
  syncId: string;
  applicationId: string;
  userId: string;
  stateCode: string;
  expectedVersion: number;
}

export interface AdmissionLease {
  leaseId: string;
}
