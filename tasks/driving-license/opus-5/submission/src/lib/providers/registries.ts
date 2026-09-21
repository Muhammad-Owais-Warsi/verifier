import type { Cov, Licence } from "../domain";
import { envOr, httpJson, requireEnv } from "./http";

/**
 * The three national systems a state licensing portal must stay in step with.
 *
 * Sarathi's National Register is the authoritative index of who holds a licence
 * anywhere in India. VAHAN/e-Challan holds enforcement actions that can
 * suspend a licence. DigiLocker is where the citizen actually reads the
 * document. All three are eventually consistent with us and with each other,
 * so every write carries a revision and every read is treated as possibly
 * stale.
 */

export type NrLicenceRecord = {
  dlNumber: string;
  citizenId: string;
  state: string;
  rtoCode: string;
  covs: Cov[];
  status: Licence["status"];
  validTill: string;
  revision: number;
  updatedAt: string;
};

export type NrPushResult =
  | { outcome: "APPLIED"; revision: number }
  | { outcome: "STALE"; remote: NrLicenceRecord }
  | { outcome: "CONFLICT"; remote: NrLicenceRecord; reason: string };

export type ChallanSummary = {
  dlNumber: string;
  pendingCount: number;
  pendingAmountPaise: number;
  /** A court-ordered disqualification blocks renewal outright. */
  disqualifiedTill?: string;
  suspendedTill?: string;
};

export const sarathiNr = {
  /**
   * A citizen may only hold one licence nationwide. Checked before issuing, and
   * again at approval time, because another state may have issued in between.
   */
  async findExistingLicence(input: {
    demographicHash: string;
    signal?: AbortSignal;
  }): Promise<NrLicenceRecord | undefined> {
    const { body } = await httpJson<{ record?: NrLicenceRecord }>({
      system: "sarathi-nr",
      url: `${envOr("NR_URL", "https://nr.sarathi.internal.gov.in/v1")}/licences/search`,
      method: "POST",
      headers: { authorization: `Bearer ${requireEnv("NR_TOKEN")}` },
      signal: input.signal,
      body: { demographic_hash: input.demographicHash },
    });
    return body.record;
  },

  /**
   * Last-writer-wins is not acceptable here, so the push is conditional on the
   * revision we last saw. A STALE response means someone else updated the
   * record and we must re-read and re-apply.
   */
  async pushLicence(input: { record: NrLicenceRecord; expectedRevision: number; signal?: AbortSignal }): Promise<NrPushResult> {
    const { body } = await httpJson<NrPushResult>({
      system: "sarathi-nr",
      url: `${envOr("NR_URL", "https://nr.sarathi.internal.gov.in/v1")}/licences/${encodeURIComponent(input.record.dlNumber)}`,
      method: "PUT",
      idempotencyKey: `${input.record.dlNumber}:${input.record.revision}`,
      headers: {
        authorization: `Bearer ${requireEnv("NR_TOKEN")}`,
        "if-match": String(input.expectedRevision),
      },
      signal: input.signal,
      body: input.record,
    });
    return body;
  },

  /** Cursor-based delta feed of changes made by other states. */
  async fetchDelta(input: { cursor?: string; limit: number; signal?: AbortSignal }): Promise<{
    records: NrLicenceRecord[];
    nextCursor?: string;
  }> {
    const query = new URLSearchParams({ limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}) });
    const { body } = await httpJson<{ records: NrLicenceRecord[]; nextCursor?: string }>({
      system: "sarathi-nr",
      url: `${envOr("NR_URL", "https://nr.sarathi.internal.gov.in/v1")}/licences/delta?${query.toString()}`,
      method: "GET",
      headers: { authorization: `Bearer ${requireEnv("NR_TOKEN")}` },
      signal: input.signal,
      timeoutMs: 30_000,
    });
    return body;
  },
};

export const vahan = {
  async challans(dlNumber: string, signal?: AbortSignal): Promise<ChallanSummary> {
    const { body } = await httpJson<ChallanSummary>({
      system: "vahan-echallan",
      url: `${envOr("VAHAN_URL", "https://vahan.internal.gov.in/v1")}/challans/${encodeURIComponent(dlNumber)}`,
      method: "GET",
      headers: { authorization: `Bearer ${requireEnv("VAHAN_TOKEN")}` },
      signal,
    });
    return body;
  },
};

export const digiLocker = {
  /** Publishes the issued document so it appears in the citizen's wallet. */
  async issueDocument(input: {
    citizenId: string;
    docType: "DRVLC" | "DLRNW";
    dlNumber: string;
    pdfStorageKey: string;
    signal?: AbortSignal;
  }): Promise<{ uri: string }> {
    const { body } = await httpJson<{ uri: string }>({
      system: "digilocker",
      url: `${envOr("DIGILOCKER_URL", "https://digilocker.internal.gov.in/v1")}/issued-documents`,
      method: "POST",
      idempotencyKey: `${input.dlNumber}:${input.docType}`,
      headers: { authorization: `Bearer ${requireEnv("DIGILOCKER_TOKEN")}` },
      signal: input.signal,
      body: {
        citizen_id: input.citizenId,
        doc_type: input.docType,
        doc_id: input.dlNumber,
        storage_key: input.pdfStorageKey,
      },
    });
    return body;
  },
};
