/**
 * CORRECT: dispatch keys are global-scoped, and the other `idempotencyKey`
 * fields in here belong to the submission's own code.
 *
 * `idempotencyKey` is not Trigger.dev vocabulary -- payment gateways, HTTP
 * clients and dedupe tables all use the name. The scope classifier accepted
 * any property with that name inside a task body, so a submission's own store
 * and gateway arguments were graded as if they were dispatch options, and a
 * waitpoint token's key was reported as a defect even though run scope is the
 * point of it there.
 *
 * No dispatch carries a key at all, so the scope check has nothing to grade
 * and replay safety is reported by its own check. Any evidence here would be
 * manufactured out of the submission's own code.
 *
 * Expected: idempotency_scope n/a, replay_safe fail.
 */
import { metadata, queue, task, wait } from "@trigger.dev/sdk";

const settlementQueue = queue({
  name: "settlement",
  concurrencyLimit: 8,
});

const retry = {
  maxAttempts: 6,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 30_000,
  randomize: true,
};

/** The submission's own dedupe table, which names its column the same way. */
async function recordPaymentIfAbsent(input: {
  idempotencyKey: string;
  applicationId: string;
  amount: number;
}): Promise<{ id: string; created: boolean }> {
  return { id: `pay_${input.applicationId}`, created: input.amount > 0 };
}

/** The submission's own gateway client, which also takes an idempotency key. */
async function createGatewayOrder(input: {
  idempotencyKey: string;
  amount: number;
  callbackUrl: string;
}): Promise<{ orderId: string }> {
  return { orderId: `ord_${input.amount}_${input.callbackUrl.length}` };
}

export const settlePayment = task({
  id: "settle-payment",
  queue: settlementQueue,
  retry,
  run: async (payload: { applicationId: string; amount: number }, { signal }) => {
    const feeKey = `fee:${payload.applicationId}:${payload.amount}`;

    const payment = await recordPaymentIfAbsent({
      idempotencyKey: feeKey,
      applicationId: payload.applicationId,
      amount: payload.amount,
    });

    // Run scope is deliberate here: a retried attempt of this run rejoins the
    // token it already created instead of orphaning it.
    const token = await wait.createToken({
      idempotencyKey: `settlement:${payment.id}`,
      idempotencyKeyTTL: "24h",
      timeout: "30m",
    });

    await createGatewayOrder({
      idempotencyKey: feeKey,
      amount: payload.amount,
      callbackUrl: token.url,
    });

    await fetch(`https://gateway.test/orders/${payment.id}`, { signal });
    const settled = await wait.forToken<{ captured: boolean }>(token);

    return { paymentId: payment.id, captured: settled.ok && settled.output.captured };
  },
  onCancel: async () => {},
});

export const collectFees = task({
  id: "collect-fees",
  retry,
  run: async (payload: { tenantId: string; applicationIds: string[] }) => {
    metadata.set("total", payload.applicationIds.length);

    const items = payload.applicationIds.map((applicationId) => ({
      payload: { applicationId, amount: 2_500 },
      options: { concurrencyKey: payload.tenantId },
    }));

    const batch = await settlePayment.batchTriggerAndWait(items);

    const failed: string[] = [];
    batch.runs.forEach((run, index) => {
      if (!run.ok) failed.push(payload.applicationIds[index]);
    });

    metadata.set("failed", failed.length);
    return { tenantId: payload.tenantId, failed: failed.length };
  },
});
