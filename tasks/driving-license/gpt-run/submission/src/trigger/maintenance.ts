import { schedules, task } from "@trigger.dev/sdk/v3";
import { deliverNotification } from "./notifications";
import { api } from "./platform";

interface TestReminder {
  reminderId: string;
  userId: string;
  applicationId: string;
  appointmentAt: string;
  centreName: string;
}

export const enqueueTestReminders = schedules.task({
  id: "enqueue-test-reminders",
  cron: "0 * * * *",
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const reminders = await api<TestReminder[]>(
      "/v1/appointments/reminders-due?windowHours=25&limit=1000",
    );
    for (const reminder of reminders) {
      await deliverNotification.trigger(
        {
          notificationId: reminder.reminderId,
          userId: reminder.userId,
          applicationId: reminder.applicationId,
          template: "TEST_REMINDER",
          channels: ["email", "sms"],
          variables: {
            applicationId: reminder.applicationId,
            appointmentAt: reminder.appointmentAt,
            centreName: reminder.centreName,
          },
        },
        {
          idempotencyKey: reminder.reminderId,
          tags: [
            `user:${reminder.userId}`,
            `application:${reminder.applicationId}`,
          ],
        },
      );
    }
    return { enqueued: reminders.length };
  },
});

export const recordNotificationReceipt = task({
  id: "record-notification-receipt",
  queue: { concurrencyLimit: 200 },
  retry: {
    maxAttempts: 8,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 120_000,
    factor: 2,
  },
  run: async (receipt: {
    receiptId: string;
    providerMessageId: string;
    channel: "email" | "sms";
    status: "DELIVERED" | "FAILED" | "BOUNCED";
    occurredAt: string;
  }) =>
    api("/v1/notifications/provider-receipts", {
      method: "POST",
      idempotencyKey: receipt.receiptId,
      body: receipt,
    }),
});

export const expireAbandonedApplications = schedules.task({
  id: "expire-abandoned-applications",
  cron: "17 2 * * *",
  queue: { concurrencyLimit: 1 },
  run: async () =>
    api<{ expired: number }>("/v1/applications/expire-abandoned", {
      method: "POST",
      idempotencyKey: `expire:${new Date().toISOString().slice(0, 10)}`,
    }),
});
