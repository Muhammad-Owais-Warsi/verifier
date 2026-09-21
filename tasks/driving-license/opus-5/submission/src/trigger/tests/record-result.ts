import { logger, schemaTask, task } from "@trigger.dev/sdk";
import { TEST_RETAKE_DAYS } from "../../lib/eligibility";
import { PermanentValidationError } from "../../lib/errors";
import { testResultSchema } from "../../lib/schemas";
import { store } from "../../lib/store";
import { addDays } from "../../lib/time";
import { advanceAfterFee } from "../applications/advance";
import { issueLicence } from "../issuance/issue";
import { notifyCitizen } from "../notifications/dispatch";
import { collectFeeFor } from "../payments/collect";
import { citizenPipelineQueue, PRIORITY, TTL } from "../queues";

/**
 * Test results, arriving from the RTO's inspector app or the online learner's
 * test. This is an externally-triggered write into a pipeline that may have
 * been idle for weeks, so it re-establishes everything from stored state and
 * refuses to act on an application that is not actually sitting a test.
 */

const MAX_AUTOMATED_RETESTS = 3;

export const recordTestResult = schemaTask({
  id: "test.record-result",
  schema: testResultSchema,
  queue: citizenPipelineQueue,
  maxDuration: 120,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (payload) => {
    const application = await store.getApplication(payload.applicationId);
    if (!application) {
      throw new PermanentValidationError("UNKNOWN_APPLICATION", `No application ${payload.applicationId}`);
    }
    if (application.status !== "TEST_SCHEDULED") {
      // A duplicate submission from the inspector app, or a result for an
      // application that was already resolved. Neither is an error.
      logger.info("Ignoring test result for an application that is not under test", {
        applicationId: application.id,
        status: application.status,
      });
      return { recorded: false, status: application.status };
    }

    const attempt = await store.nextTestAttempt(application.id);

    if (payload.passed) {
      await store.transitionApplication(application.id, "TEST_PASSED", {
        reason: `${payload.kind} passed on attempt ${attempt} (examiner ${payload.examinerId})`,
      });
      await notifyCitizen({
        citizenId: payload.citizenId,
        event: "TEST_PASSED",
        mobile: application.applicant.mobile,
        email: application.applicant.email,
        language: application.applicant.language,
        dedupeKey: `test-passed:${application.id}:${attempt}`,
        variables: { applicationId: application.id, testKind: payload.kind },
      });

      await issueLicence.trigger(
        {
          applicationId: application.id,
          citizenId: payload.citizenId,
          rtoCode: application.rtoCode,
          covs: application.covs,
          service: application.service,
        },
        {
          concurrencyKey: payload.citizenId,
          priority: PRIORITY.STANDARD,
          ttl: TTL.BACKGROUND,
          idempotencyKey: `issue:${application.id}`,
          idempotencyKeyTTL: "30d",
          tags: [`application:${application.id}`],
        },
      );
      return { recorded: true, status: "TEST_PASSED" as const, attempt };
    }

    await store.transitionApplication(application.id, "TEST_FAILED", {
      reason: `${payload.kind} failed on attempt ${attempt}: ${payload.remarks ?? "no remarks"}`,
    });

    const retakeAfter = addDays(new Date(payload.conductedAt), TEST_RETAKE_DAYS);
    await notifyCitizen({
      citizenId: payload.citizenId,
      event: "TEST_FAILED",
      mobile: application.applicant.mobile,
      email: application.applicant.email,
      language: application.applicant.language,
      dedupeKey: `test-failed:${application.id}:${attempt}`,
      variables: { applicationId: application.id, retakeAfter: retakeAfter.toISOString() },
    });

    if (attempt >= MAX_AUTOMATED_RETESTS) {
      // Three failures means a fresh application, with fresh documents. The
      // portal tells the citizen; nothing is auto-scheduled.
      logger.info("Retest limit reached", { applicationId: application.id, attempt });
      return { recorded: true, status: "TEST_FAILED" as const, attempt, retestScheduled: false };
    }

    await scheduleRetest.trigger(
      { applicationId: application.id, citizenId: payload.citizenId, attempt: attempt + 1 },
      {
        // The statutory cooling-off period, enforced by the queue rather than
        // by asking the citizen to come back at the right time.
        delay: retakeAfter,
        concurrencyKey: payload.citizenId,
        priority: PRIORITY.STANDARD,
        ttl: TTL.BACKGROUND,
        idempotencyKey: `retest:${application.id}:${attempt + 1}`,
        idempotencyKeyTTL: "60d",
        tags: [`application:${application.id}`],
      },
    );

    return { recorded: true, status: "TEST_FAILED" as const, attempt, retestScheduled: true };
  },
});

export const scheduleRetest = task({
  id: "test.schedule-retest",
  queue: citizenPipelineQueue,
  maxDuration: 600,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (payload: { applicationId: string; citizenId: string; attempt: number }) => {
    const application = await store.getApplication(payload.applicationId);
    if (!application || application.status !== "TEST_FAILED") {
      return { scheduled: false, reason: "application is no longer awaiting a retest" };
    }

    await store.transitionApplication(application.id, "FEE_PENDING", { reason: `retest attempt ${payload.attempt}` });

    const settlement = await collectFeeFor({
      applicationId: application.id,
      citizenId: payload.citizenId,
      service: application.service,
      covs: application.covs,
      testAttempt: payload.attempt,
      deliverByPost: false,
      feePurpose: "RETEST",
    });

    if (settlement.outcome !== "PAID") {
      // The citizen has not paid the retest fee. They can retry from the
      // portal; nothing is lost and no slot was held.
      return { scheduled: false, reason: settlement.reason ?? settlement.outcome };
    }

    await store.transitionApplication(application.id, "FEE_PAID", {
      reason: `retest fee collected (${settlement.paymentId})`,
      patch: { paymentId: settlement.paymentId, slotId: undefined },
    });

    await advanceAfterFee.trigger(
      { applicationId: application.id, citizenId: payload.citizenId },
      { concurrencyKey: payload.citizenId, priority: PRIORITY.STANDARD, ttl: TTL.BACKGROUND, tags: [`application:${application.id}`] },
    );

    return { scheduled: true };
  },
});
