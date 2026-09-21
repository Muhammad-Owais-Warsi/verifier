import type { ApplicantDocument, DocumentKind } from "../domain";
import { envOr, httpJson, requireEnv } from "./http";

/**
 * UIDAI eKYC and the document pipeline.
 *
 * The full Aadhaar number never enters this service: the portal exchanges it
 * for a short-lived reference token at the edge, and everything downstream
 * works with that token. Nothing in here is ever logged.
 */

export type EkycResult = {
  matched: boolean;
  /** Reasons are UIDAI codes, safe to show the citizen. */
  mismatchedFields: string[];
  demographicHash: string;
  /** UIDAI asks us to stop and re-consent rather than retry these. */
  requiresReconsent: boolean;
};

export type DocumentVerdict = {
  kind: DocumentKind;
  storageKey: string;
  outcome: "ACCEPTED" | "REJECTED" | "MANUAL_REVIEW";
  reasons: string[];
  /** 0-1 similarity between the uploaded photo and the eKYC photo. */
  faceMatchScore?: number;
};

export const identity = {
  async ekyc(input: {
    referenceToken: string;
    fullName: string;
    dateOfBirth: string;
    signal?: AbortSignal;
  }): Promise<EkycResult> {
    const { body } = await httpJson<EkycResult>({
      system: "uidai-ekyc",
      url: `${envOr("EKYC_URL", "https://ekyc.internal.gov.in/v2")}/verify`,
      method: "POST",
      headers: { "x-auth-ua": requireEnv("EKYC_AUA_CODE"), authorization: `Bearer ${requireEnv("EKYC_TOKEN")}` },
      signal: input.signal,
      timeoutMs: 20_000,
      body: {
        reference_token: input.referenceToken,
        name: input.fullName,
        dob: input.dateOfBirth,
      },
    });
    return body;
  },

  /**
   * Malware scan, OCR, tamper detection and face match in one upstream call.
   * Anything the model is unsure about comes back as MANUAL_REVIEW rather than
   * a rejection — a wrongly rejected document is a citizen losing a day.
   */
  async verifyDocument(input: {
    applicationId: string;
    document: ApplicantDocument;
    referenceFaceKey?: string;
    signal?: AbortSignal;
  }): Promise<DocumentVerdict> {
    const { body } = await httpJson<DocumentVerdict>({
      system: "doc-verify",
      url: `${envOr("DOC_VERIFY_URL", "https://docs.internal.gov.in/v1")}/verify`,
      method: "POST",
      idempotencyKey: `${input.applicationId}:${input.document.sha256}`,
      headers: { authorization: `Bearer ${requireEnv("DOC_VERIFY_TOKEN")}` },
      signal: input.signal,
      timeoutMs: 30_000,
      body: {
        kind: input.document.kind,
        storage_key: input.document.storageKey,
        checksum: input.document.sha256,
        reference_face_key: input.referenceFaceKey,
      },
    });
    return body;
  },
};
