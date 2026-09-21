import type { Applicant, ApplicantDocument, Cov, DocumentKind, Service } from "./domain";
import { TRANSPORT_COVS } from "./domain";
import { ageInYears, daysBetween } from "./time";

/**
 * Statutory eligibility, evaluated before a rupee is taken. Getting this wrong
 * in the other order — charge first, reject later — is what generates refund
 * volume, so every check that can be made from data we already hold is made
 * here, synchronously, at submission time.
 */

export type EligibilityFinding = { code: string; message: string };

const MINIMUM_AGE: Record<string, number> = {
  MC50CC: 16,
  MCWOG: 18,
  MCWG: 18,
  LMV: 18,
  LMV_NT: 18,
  LMV_TR: 20,
  TRANS: 20,
  HGMV: 20,
  HPMV: 20,
  HTV: 20,
  TRC: 20,
  ERIKSH: 18,
};

/** Documents every application needs, before service-specific additions. */
const BASE_DOCUMENTS: DocumentKind[] = ["AADHAAR", "PASSPORT_PHOTO", "SIGNATURE", "ADDRESS_PROOF", "AGE_PROOF"];

/** Minimum gap between the learner's licence and the permanent licence test. */
export const LL_TO_DL_MIN_DAYS = 30;
/** A learner's licence is valid for six months and cannot be extended. */
export const LL_VALIDITY_DAYS = 180;
/** Cooling-off period before a failed test may be retaken (CMVR Rule 15). */
export const TEST_RETAKE_DAYS = 7;

function requiredDocuments(service: Service, covs: Cov[], applicant: Applicant, at: Date): DocumentKind[] {
  const required = [...BASE_DOCUMENTS];
  const needsMedical = ageInYears(applicant.dateOfBirth, at) >= 40 || covs.some((cov) => TRANSPORT_COVS.includes(cov));
  if (needsMedical) required.push("FORM_1A_MEDICAL");
  else required.push("FORM_1");
  if (service !== "LL_NEW") required.push("EXISTING_LICENCE");
  // A transport endorsement requires proof of training from a licensed school.
  if (covs.some((cov) => TRANSPORT_COVS.includes(cov))) required.push("FORM_5_DRIVING_SCHOOL");
  // Applying outside the state where the licence was issued needs an NOC.
  if (applicant.existingDlNumber && !applicant.existingDlNumber.startsWith(applicant.state)) required.push("NOC");
  return required;
}

export function checkEligibility(input: {
  service: Service;
  applicant: Applicant;
  covs: Cov[];
  documents: ApplicantDocument[];
  /** Issue date of the learner's licence, for permanent licence applications. */
  learnerLicenceIssuedAt?: string;
  at?: Date;
}): EligibilityFinding[] {
  const at = input.at ?? new Date();
  const findings: EligibilityFinding[] = [];
  const age = ageInYears(input.applicant.dateOfBirth, at);

  for (const cov of input.covs) {
    const minimum = MINIMUM_AGE[cov];
    if (minimum !== undefined && age < minimum) {
      findings.push({ code: "UNDERAGE", message: `Minimum age for ${cov} is ${minimum}; applicant is ${age}` });
    }
  }

  if (input.covs.some((cov) => TRANSPORT_COVS.includes(cov)) && !input.applicant.existingDlNumber) {
    findings.push({
      code: "TRANSPORT_WITHOUT_LMV",
      message: "A transport endorsement requires an existing light motor vehicle licence",
    });
  }

  const provided = new Set(input.documents.map((document) => document.kind));
  for (const kind of requiredDocuments(input.service, input.covs, input.applicant, at)) {
    if (!provided.has(kind)) {
      findings.push({ code: "MISSING_DOCUMENT", message: `Required document ${kind} was not uploaded` });
    }
  }

  if (input.service === "DL_NEW") {
    if (!input.learnerLicenceIssuedAt) {
      findings.push({ code: "NO_LEARNERS_LICENCE", message: "A valid learner's licence is required" });
    } else {
      const heldFor = daysBetween(new Date(input.learnerLicenceIssuedAt), at);
      if (heldFor < LL_TO_DL_MIN_DAYS) {
        findings.push({
          code: "LL_TOO_RECENT",
          message: `The learner's licence must be at least ${LL_TO_DL_MIN_DAYS} days old; it is ${heldFor}`,
        });
      }
      if (heldFor > LL_VALIDITY_DAYS) {
        findings.push({ code: "LL_EXPIRED", message: "The learner's licence has expired; apply for a fresh one" });
      }
    }
  }

  return findings;
}

/**
 * Licence validity under CMVR Rule 17: twenty years or the holder's fiftieth
 * birthday for private classes, five years thereafter, and a separate, much
 * shorter clock for transport endorsements.
 */
export function computeValidity(input: {
  dateOfBirth: string;
  covs: Cov[];
  issuedAt: Date;
}): { validTill: string; transportValidTill?: string } {
  const age = ageInYears(input.dateOfBirth, input.issuedAt);
  const years = age >= 50 ? 5 : Math.min(20, Math.max(5, 50 - age));
  const validTill = new Date(input.issuedAt);
  validTill.setUTCFullYear(validTill.getUTCFullYear() + years);

  let transportValidTill: string | undefined;
  if (input.covs.some((cov) => TRANSPORT_COVS.includes(cov))) {
    const transport = new Date(input.issuedAt);
    transport.setUTCFullYear(transport.getUTCFullYear() + 3);
    transportValidTill = transport.toISOString();
  }

  return { validTill: validTill.toISOString(), transportValidTill };
}

/** A learner's licence expires six months after issue, with no renewal. */
export function learnerValidity(issuedAt: Date): string {
  return new Date(issuedAt.getTime() + LL_VALIDITY_DAYS * 86_400_000).toISOString();
}
