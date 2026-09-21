/**
 * ANTI-PATTERN: parks on an external party with no deadline.
 *
 * Using a waitpoint is the right call, so the external-completion check passes
 * this. But nothing bounds the wait: if the payment page is abandoned and the
 * gateway never calls back, the run waits forever. A checkpointed run holds no
 * worker, so nothing looks slow and nothing errors -- the application simply
 * never finishes and no one is told.
 *
 * Expected to fail: wait_bounded.
 */
import { metadata, queue, task, wait } from "@trigger.dev/sdk";

const paymentQueue = queue({ name: "payments", concurrencyLimit: 10 });

const retry = { maxAttempts: 5, minTimeoutInMs: 1_000 };

export const collectPayment = task({
  id: "collect-payment",
  queue: paymentQueue,
  retry,
  run: async (payload: { applicationId: string; citizenId: string }) => {
    metadata.set("stage", "awaiting-payment");

    const token = await wait.createToken();
    const settled = await wait.forToken<{ paid: boolean; reference: string }>(token);

    if (!settled.ok || !settled.output.paid) {
      return { applicationId: payload.applicationId, paid: false };
    }

    metadata.set("stage", "paid");
    return { applicationId: payload.applicationId, paid: true, reference: settled.output.reference };
  },
});
