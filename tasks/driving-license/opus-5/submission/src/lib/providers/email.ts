import { envOr, httpJson, requireEnv } from "./http";
import { PermanentValidationError } from "../errors";

/**
 * Transactional email. Unlike SMS there is no template registry to satisfy, but
 * reputation still has to be protected: hard bounces and complaints go on a
 * suppression list and are never retried, because repeatedly mailing dead
 * addresses is what gets a government sender domain blocklisted.
 */

export type EmailRequest = {
  to: string;
  templateKey: string;
  language: string;
  variables: Record<string, string>;
  /** PDF receipts and licence copies, passed by storage key not by value. */
  attachments?: Array<{ filename: string; storageKey: string }>;
  clientReference: string;
};

export type EmailResult = {
  providerMessageId: string;
  provider: string;
  suppressed: boolean;
};

const HARD_FAILURES = new Set(["INVALID_RECIPIENT", "SUPPRESSED", "COMPLAINED", "BLOCKED_DOMAIN"]);

export const emailProvider = {
  async send(request: EmailRequest, signal?: AbortSignal): Promise<EmailResult> {
    const { body } = await httpJson<{ messageId: string; status: string; reason?: string }>({
      system: "email",
      url: `${envOr("EMAIL_URL", "https://mail.internal.gov.in/v1")}/send`,
      method: "POST",
      idempotencyKey: request.clientReference,
      headers: { authorization: `Bearer ${requireEnv("EMAIL_TOKEN")}` },
      signal,
      timeoutMs: 15_000,
      body: {
        to: request.to,
        template: request.templateKey,
        locale: request.language,
        variables: request.variables,
        attachments: request.attachments,
        client_ref: request.clientReference,
      },
    });

    if (body.reason && HARD_FAILURES.has(body.reason)) {
      throw new PermanentValidationError(`EMAIL_${body.reason}`, `Recipient is undeliverable`);
    }

    return {
      providerMessageId: body.messageId,
      provider: "primary",
      suppressed: body.status === "suppressed",
    };
  },
};
