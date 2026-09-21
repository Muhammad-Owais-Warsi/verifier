import { envOr, httpJson, requireEnv } from "./http";
import { PermanentValidationError } from "../errors";

/**
 * SMS delivery through DLT-registered aggregators.
 *
 * Indian SMS is template-bound: the header (sender id) and the content template
 * must both be pre-registered on a DLT platform, and the variable parts are the
 * only thing we may change at send time. Sending an unregistered body is
 * silently dropped by the operator, so `SmsRequest` has no free-text field at
 * all — callers pass a template id and its variables.
 */

export type SmsRequest = {
  mobile: string;
  /** DLT-registered content template id. */
  dltTemplateId: string;
  /** DLT-registered header, e.g. "PRVHAN". */
  senderId: string;
  variables: string[];
  /** Transactional traffic is exempt from DND and quiet hours. */
  transactional: boolean;
  /** Our own id, echoed back on delivery receipts. */
  clientReference: string;
};

export type SmsResult = {
  providerMessageId: string;
  provider: string;
  accepted: boolean;
  /** Set when the operator rejected the message outright. */
  rejectionCode?: string;
};

type ProviderConfig = { name: string; urlEnv: string; tokenEnv: string; defaultUrl: string };

const PROVIDERS: ProviderConfig[] = [
  { name: "primary", urlEnv: "SMS_PRIMARY_URL", tokenEnv: "SMS_PRIMARY_TOKEN", defaultUrl: "https://sms1.internal.gov.in/v1/send" },
  { name: "secondary", urlEnv: "SMS_SECONDARY_URL", tokenEnv: "SMS_SECONDARY_TOKEN", defaultUrl: "https://sms2.internal.gov.in/v1/send" },
];

/**
 * Operator rejections that will never succeed. Retrying these wastes the
 * citizen's daily allowance and, for DND, is a compliance breach.
 */
const PERMANENT_REJECTIONS = new Set(["INVALID_NUMBER", "DND_BLOCKED", "TEMPLATE_MISMATCH", "BLACKLISTED"]);

export const smsProvider = {
  /**
   * Sends through the primary aggregator and falls back to the secondary on
   * transport-level failure only. A message the operator *rejected* is not
   * retried elsewhere — the second aggregator talks to the same operator.
   */
  async send(request: SmsRequest, options: { preferProvider?: string; signal?: AbortSignal } = {}): Promise<SmsResult> {
    const ordered = options.preferProvider
      ? [...PROVIDERS].sort((a, b) => (a.name === options.preferProvider ? -1 : b.name === options.preferProvider ? 1 : 0))
      : PROVIDERS;

    let lastTransportError: unknown;
    for (const provider of ordered) {
      try {
        const { body } = await httpJson<{ messageId: string; accepted: boolean; rejectionCode?: string }>({
          system: `sms-${provider.name}`,
          url: envOr(provider.urlEnv, provider.defaultUrl),
          method: "POST",
          idempotencyKey: request.clientReference,
          headers: { authorization: `Bearer ${requireEnv(provider.tokenEnv)}` },
          signal: options.signal,
          timeoutMs: 10_000,
          body: {
            to: request.mobile,
            sender: request.senderId,
            template_id: request.dltTemplateId,
            variables: request.variables,
            route: request.transactional ? "transactional" : "service",
            client_ref: request.clientReference,
          },
        });

        if (!body.accepted && body.rejectionCode && PERMANENT_REJECTIONS.has(body.rejectionCode)) {
          throw new PermanentValidationError(`SMS_${body.rejectionCode}`, `Operator rejected message for ${request.dltTemplateId}`);
        }

        return {
          providerMessageId: body.messageId,
          provider: provider.name,
          accepted: body.accepted,
          rejectionCode: body.rejectionCode,
        };
      } catch (error) {
        if (error instanceof PermanentValidationError) throw error;
        lastTransportError = error;
      }
    }
    throw lastTransportError ?? new Error("No SMS provider configured");
  },
};
