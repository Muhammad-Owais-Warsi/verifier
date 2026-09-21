import { envOr, httpJson, requireEnv } from "./http";

/**
 * Card personalisation bureau and India Post. The bureau batches cards into
 * daily print files per RTO, which is why issuance hands work over rather than
 * waiting for it.
 */

export type PrintJob = {
  jobId: string;
  status: "QUEUED" | "PRINTING" | "PRINTED" | "FAILED";
  expectedDispatchDate: string;
};

export type DispatchInfo = {
  awb: string;
  carrier: "INDIA_POST" | "COURIER";
  status: "MANIFESTED" | "IN_TRANSIT" | "DELIVERED" | "RTO_RETURNED" | "LOST";
  deliveredAt?: string;
};

export const cardBureau = {
  async queuePrint(input: {
    dlNumber: string;
    rtoCode: string;
    /** Signed PDF/biometric bundle in the document store. */
    artefactKey: string;
    signal?: AbortSignal;
  }): Promise<PrintJob> {
    const { body } = await httpJson<PrintJob>({
      system: "card-bureau",
      url: `${envOr("CARD_BUREAU_URL", "https://cards.internal.gov.in/v1")}/print-jobs`,
      method: "POST",
      idempotencyKey: `print:${input.dlNumber}`,
      headers: { authorization: `Bearer ${requireEnv("CARD_BUREAU_TOKEN")}` },
      signal: input.signal,
      body: { dl_number: input.dlNumber, rto: input.rtoCode, artefact_key: input.artefactKey },
    });
    return body;
  },

  async getPrintJob(jobId: string, signal?: AbortSignal): Promise<PrintJob> {
    const { body } = await httpJson<PrintJob>({
      system: "card-bureau",
      url: `${envOr("CARD_BUREAU_URL", "https://cards.internal.gov.in/v1")}/print-jobs/${encodeURIComponent(jobId)}`,
      method: "GET",
      headers: { authorization: `Bearer ${requireEnv("CARD_BUREAU_TOKEN")}` },
      signal,
    });
    return body;
  },
};

export const postal = {
  async track(awb: string, signal?: AbortSignal): Promise<DispatchInfo> {
    const { body } = await httpJson<DispatchInfo>({
      system: "india-post",
      url: `${envOr("POSTAL_URL", "https://post.internal.gov.in/v1")}/consignments/${encodeURIComponent(awb)}`,
      method: "GET",
      headers: { authorization: `Bearer ${requireEnv("POSTAL_TOKEN")}` },
      signal,
    });
    return body;
  },
};
