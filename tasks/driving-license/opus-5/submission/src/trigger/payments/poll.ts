import { logger, task, wait } from "@trigger.dev/sdk";
import type { GatewayPaymentState } from "../../lib/providers/payment-gateway";
import { paymentGateway } from "../../lib/providers/payment-gateway";
import { gatewayQueue, PRIORITY, TTL } from "../queues";

/**
 * Authoritative status read with backoff.
 *
 * Used whenever the webhook did not arrive in time. The waits between polls are
 * real waitpoints, so a run sitting here for five minutes is not occupying a
 * worker — which is what makes it affordable to poll for every payment whose
 * callback was lost rather than only the ones a human noticed.
 */

const BACKOFF_SECONDS = [5, 10, 30, 60, 120, 300, 300];

const TERMINAL: ReadonlySet<GatewayPaymentState["status"]> = new Set([
  "CAPTURED",
  "FAILED",
  "EXPIRED",
  "REFUNDED",
]);

export const pollPaymentStatus = task({
  id: "payment.poll",
  queue: gatewayQueue,
  // Long enough to walk the whole backoff ladder; the waits are checkpointed so
  // this is wall-clock time, not compute time.
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (payload: { paymentId: string; orderId: string }, { signal }): Promise<GatewayPaymentState> => {
    let state = await paymentGateway.getPayment(payload.orderId, signal);

    for (const seconds of BACKOFF_SECONDS) {
      if (TERMINAL.has(state.status)) break;
      await wait.for({ seconds });
      state = await paymentGateway.getPayment(payload.orderId, signal);
    }

    if (!TERMINAL.has(state.status)) {
      // Still ambiguous after ~13 minutes. The caller must treat this as
      // "unknown", never as "failed": the citizen may well have been debited.
      logger.warn("Payment still not terminal after full backoff", {
        paymentId: payload.paymentId,
        orderId: payload.orderId,
        status: state.status,
      });
    }

    return state;
  },
});

export const POLL_TRIGGER_OPTIONS = {
  priority: PRIORITY.PAYMENT,
  ttl: TTL.BACKGROUND,
} as const;
