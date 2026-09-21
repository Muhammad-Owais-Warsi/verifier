import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { PermanentValidationError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { paymentGateway } from "../../lib/providers/payment-gateway";
import { gatewayEventSchema, gatewayWebhookSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { gatewayQueue, PRIORITY, TTL } from "../queues";
import { reconcilePayment } from "./reconcile";

/**
 * Gateway webhook ingress.
 *
 * The HTTP endpoint in front of this does nothing but hand over the raw body
 * and signature and return 200 — aggregators retry aggressively and disable
 * endpoints that are slow, so no work happens on their connection.
 *
 * Three defences, in order: the signature must verify, the event id must be
 * unseen, and the resulting action must be safe to perform twice. Only after
 * all three does anything touch the ledger.
 */

export type WebhookOutcome = {
  outcome: "RESUMED" | "RECONCILING" | "DUPLICATE" | "UNKNOWN_ORDER";
  paymentId?: string;
};

export const handleGatewayWebhook = schemaTask({
  id: "payment.gateway-webhook",
  schema: gatewayWebhookSchema,
  queue: gatewayQueue,
  maxDuration: 60,
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 15_000, randomize: true },
  run: async (payload): Promise<WebhookOutcome> => {
    if (!paymentGateway.verifyWebhookSignature(payload.rawBody, payload.signature)) {
      // Never retried, never logged with the body: an unsigned callback is
      // either an attack or a misconfiguration, and both need a human.
      throw new PermanentValidationError("WEBHOOK_BAD_SIGNATURE", "Signature verification failed");
    }

    const parsed = gatewayEventSchema.safeParse(JSON.parse(payload.rawBody));
    if (!parsed.success) {
      throw new PermanentValidationError("WEBHOOK_MALFORMED", parsed.error.message);
    }
    const event = parsed.data;

    if ((await store.claimGatewayEvent(event.eventId)) === "ALREADY_CLAIMED") {
      return { outcome: "DUPLICATE" };
    }

    const payment = await store.findPaymentByOrderId(event.orderId);
    if (!payment) {
      // A capture for an order this environment never created. Could be a
      // cross-environment misroute, could be a replay against a wiped ledger.
      // Either way it is money we cannot attribute, so it goes to a human.
      await store.recordDeadLetter({
        id: newId("dlq"),
        kind: "payment.orphan-callback",
        reference: event.orderId,
        payload: event,
        error: "Callback for an unknown order",
        attempts: 1,
        createdAt: nowIso(),
      });
      logger.error("Callback for unknown order", { orderId: event.orderId, event: event.event });
      return { outcome: "UNKNOWN_ORDER" };
    }

    // Wake the checkout run if one is still waiting. Completing the token is
    // the fast path and keeps the citizen's tab moving.
    if (payment.waitTokenId) {
      try {
        await wait.completeToken(payment.waitTokenId, event);
        return { outcome: "RESUMED", paymentId: payment.id };
      } catch (error) {
        // Already completed, already timed out, or the run is gone. Not an
        // error — it just means nobody is listening and we own the outcome.
        logger.info("No run waiting on this payment; reconciling instead", {
          paymentId: payment.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await reconcilePayment.trigger(
      { paymentId: payment.id, source: "WEBHOOK" },
      { priority: PRIORITY.PAYMENT, ttl: TTL.BACKGROUND, tags: [`payment:${payment.id}`] },
    );
    return { outcome: "RECONCILING", paymentId: payment.id };
  },
});
