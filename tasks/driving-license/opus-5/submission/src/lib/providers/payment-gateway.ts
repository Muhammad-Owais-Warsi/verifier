import { createHmac, timingSafeEqual } from "node:crypto";
import { envOr, httpJson, requireEnv } from "./http";

/**
 * Bharatkosh-style payment aggregator. Three properties matter and are relied
 * on by `src/trigger/payments`:
 *
 * 1. `createOrder` is idempotent on the key we supply, so a retried run never
 *    produces a second order for the same fee.
 * 2. `getPayment` is authoritative. Webhooks are a latency optimisation, never
 *    a source of truth — every terminal decision re-reads the gateway.
 * 3. `refund` is idempotent on the refund id we supply.
 */

export type GatewayOrder = {
  orderId: string;
  /** Hosted page the citizen is redirected to. */
  checkoutUrl: string;
  amountPaise: number;
  expiresAt: string;
};

export type GatewayPaymentState = {
  orderId: string;
  paymentId?: string;
  status: "CREATED" | "PENDING" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "EXPIRED" | "REFUNDED";
  amountPaise: number;
  capturedAmountPaise?: number;
  refundedAmountPaise?: number;
  method?: string;
  failureCode?: string;
  /** Present once the bank has settled; drives end-of-day reconciliation. */
  settlementId?: string;
  updatedAt: string;
};

export type GatewayRefund = {
  refundId: string;
  status: "PENDING" | "PROCESSED" | "FAILED";
  amountPaise: number;
  failureCode?: string;
};

export type SettlementRow = {
  orderId: string;
  paymentId: string;
  status: "CAPTURED" | "FAILED" | "REFUNDED";
  amountPaise: number;
  settledAt: string;
};

function baseUrl(): string {
  return envOr("PAYMENT_GATEWAY_URL", "https://api.payments.internal.gov.in/v1");
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${requireEnv("PAYMENT_GATEWAY_KEY")}` };
}

export const paymentGateway = {
  async createOrder(input: {
    idempotencyKey: string;
    amountPaise: number;
    applicationId: string;
    citizenId: string;
    /** Gateway posts the settlement event here; it is a Trigger waitpoint URL. */
    callbackUrl: string;
    expiresInSeconds: number;
    signal?: AbortSignal;
  }): Promise<GatewayOrder> {
    const { body } = await httpJson<GatewayOrder>({
      system: "payment-gateway",
      url: `${baseUrl()}/orders`,
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      headers: authHeaders(),
      signal: input.signal,
      body: {
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.applicationId,
        notes: { citizenId: input.citizenId, applicationId: input.applicationId },
        callback_url: input.callbackUrl,
        expires_in: input.expiresInSeconds,
      },
    });
    return body;
  },

  async getPayment(orderId: string, signal?: AbortSignal): Promise<GatewayPaymentState> {
    const { body } = await httpJson<GatewayPaymentState>({
      system: "payment-gateway",
      url: `${baseUrl()}/orders/${encodeURIComponent(orderId)}`,
      method: "GET",
      headers: authHeaders(),
      signal,
    });
    return body;
  },

  async refund(input: {
    refundId: string;
    paymentId: string;
    amountPaise: number;
    reason: string;
    signal?: AbortSignal;
  }): Promise<GatewayRefund> {
    const { body } = await httpJson<GatewayRefund>({
      system: "payment-gateway",
      url: `${baseUrl()}/payments/${encodeURIComponent(input.paymentId)}/refunds`,
      method: "POST",
      idempotencyKey: input.refundId,
      headers: authHeaders(),
      signal: input.signal,
      body: { amount: input.amountPaise, reason: input.reason, refund_id: input.refundId },
    });
    return body;
  },

  /** End-of-day file the bank publishes; the backstop for every lost webhook. */
  async fetchSettlement(dateKey: string, cursor?: string, signal?: AbortSignal): Promise<{ rows: SettlementRow[]; nextCursor?: string }> {
    const query = new URLSearchParams({ date: dateKey, ...(cursor ? { cursor } : {}) });
    const { body } = await httpJson<{ rows: SettlementRow[]; nextCursor?: string }>({
      system: "payment-gateway",
      url: `${baseUrl()}/settlements?${query.toString()}`,
      method: "GET",
      headers: authHeaders(),
      signal,
    });
    return body;
  },

  /**
   * Constant-time signature check. A webhook that fails this is discarded
   * without touching any state — an attacker must not be able to mark an
   * unpaid application as paid.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", requireEnv("PAYMENT_GATEWAY_WEBHOOK_SECRET")).update(rawBody).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "hex");
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  },
};
