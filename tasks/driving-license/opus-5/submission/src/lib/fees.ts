import type { Cov, FeeLine, Service } from "./domain";
import { TRANSPORT_COVS } from "./domain";
import { daysBetween } from "./time";

/**
 * Statutory fees from CMVR Rule 32, in paise. Kept as integers end to end: the
 * gateway, the ledger and the receipt all speak paise, so a rounding difference
 * can never open a reconciliation mismatch.
 */
const RUPEE = 100;

const FEE_TABLE = {
  LEARNERS_LICENCE_PER_COV: 150 * RUPEE,
  LL_TEST: 50 * RUPEE,
  LL_TEST_REPEAT: 50 * RUPEE,
  DRIVING_TEST: 300 * RUPEE,
  DRIVING_TEST_REPEAT: 300 * RUPEE,
  DL_ISSUE: 200 * RUPEE,
  DL_RENEWAL: 200 * RUPEE,
  DL_DUPLICATE: 200 * RUPEE,
  DL_ADD_COV: 500 * RUPEE,
  DL_PARTICULARS_CHANGE: 200 * RUPEE,
  IDP: 1_000 * RUPEE,
  SMART_CARD: 200 * RUPEE,
  SPEED_POST: 40 * RUPEE,
  /** Charged per year (or part thereof) beyond the 30-day grace period. */
  RENEWAL_LATE_FEE_PER_YEAR: 1_000 * RUPEE,
  /** Beyond five years lapsed the licence cannot be renewed at all. */
  MAX_LATE_YEARS: 5,
} as const;

export const RENEWAL_GRACE_DAYS = 30;

export type FeeContext = {
  service: Service;
  covs: Cov[];
  /** Expiry of the licence being renewed, if any. */
  previousValidTill?: string;
  /** Nth attempt at the test being paid for; 1 is the first, included attempt. */
  testAttempt?: number;
  /** Physical card posted to the applicant rather than collected at the RTO. */
  deliverByPost?: boolean;
  at?: Date;
};

export type FeeQuote = {
  lines: FeeLine[];
  totalPaise: number;
  /** Set when the service cannot be priced, e.g. a licence lapsed too long. */
  ineligibleReason?: string;
};

function line(head: string, amountPaise: number): FeeLine {
  return { head, amountPaise };
}

/**
 * A lapsed licence attracts a late fee for every started year past the grace
 * period, and stops being renewable entirely after five years.
 */
function lateFeeLines(previousValidTill: string | undefined, at: Date): { lines: FeeLine[]; ineligibleReason?: string } {
  if (!previousValidTill) return { lines: [] };
  const lapsedDays = daysBetween(new Date(previousValidTill), at);
  if (lapsedDays <= RENEWAL_GRACE_DAYS) return { lines: [] };

  const lateYears = Math.ceil((lapsedDays - RENEWAL_GRACE_DAYS) / 365);
  if (lateYears > FEE_TABLE.MAX_LATE_YEARS) {
    return {
      lines: [],
      ineligibleReason: `Licence lapsed ${lateYears} years ago; a fresh application with a driving test is required`,
    };
  }
  return { lines: [line("LATE_FEE", lateYears * FEE_TABLE.RENEWAL_LATE_FEE_PER_YEAR)] };
}

export function quoteFee(context: FeeContext): FeeQuote {
  const at = context.at ?? new Date();
  const attempt = context.testAttempt ?? 1;
  const lines: FeeLine[] = [];
  let ineligibleReason: string | undefined;

  switch (context.service) {
    case "LL_NEW":
    case "LL_ADD_COV": {
      for (const cov of context.covs) {
        lines.push(line(`LL_FEE_${cov}`, FEE_TABLE.LEARNERS_LICENCE_PER_COV));
      }
      lines.push(line(attempt > 1 ? "LL_TEST_REPEAT" : "LL_TEST", FEE_TABLE.LL_TEST));
      break;
    }
    case "LL_DUPLICATE": {
      lines.push(line("LL_DUPLICATE", FEE_TABLE.LEARNERS_LICENCE_PER_COV));
      break;
    }
    case "DL_NEW": {
      lines.push(line(attempt > 1 ? "DRIVING_TEST_REPEAT" : "DRIVING_TEST", FEE_TABLE.DRIVING_TEST));
      lines.push(line("DL_ISSUE", FEE_TABLE.DL_ISSUE));
      lines.push(line("SMART_CARD", FEE_TABLE.SMART_CARD));
      break;
    }
    case "DL_ADD_COV": {
      lines.push(line("DL_ADD_COV", FEE_TABLE.DL_ADD_COV));
      lines.push(line(attempt > 1 ? "DRIVING_TEST_REPEAT" : "DRIVING_TEST", FEE_TABLE.DRIVING_TEST));
      lines.push(line("SMART_CARD", FEE_TABLE.SMART_CARD));
      break;
    }
    case "DL_RENEWAL": {
      lines.push(line("DL_RENEWAL", FEE_TABLE.DL_RENEWAL));
      lines.push(line("SMART_CARD", FEE_TABLE.SMART_CARD));
      const late = lateFeeLines(context.previousValidTill, at);
      lines.push(...late.lines);
      ineligibleReason = late.ineligibleReason;
      // A lapsed transport endorsement needs the test taken again.
      if (late.lines.length > 0 && context.covs.some((cov) => TRANSPORT_COVS.includes(cov))) {
        lines.push(line("DRIVING_TEST", FEE_TABLE.DRIVING_TEST));
      }
      break;
    }
    case "DL_DUPLICATE": {
      lines.push(line("DL_DUPLICATE", FEE_TABLE.DL_DUPLICATE));
      lines.push(line("SMART_CARD", FEE_TABLE.SMART_CARD));
      break;
    }
    case "DL_CHANGE_ADDRESS":
    case "DL_CHANGE_NAME": {
      lines.push(line("DL_PARTICULARS_CHANGE", FEE_TABLE.DL_PARTICULARS_CHANGE));
      lines.push(line("SMART_CARD", FEE_TABLE.SMART_CARD));
      break;
    }
    case "DL_IDP": {
      lines.push(line("IDP", FEE_TABLE.IDP));
      break;
    }
    case "DL_SURRENDER_COV": {
      lines.push(line("DL_PARTICULARS_CHANGE", FEE_TABLE.DL_PARTICULARS_CHANGE));
      break;
    }
  }

  if (context.deliverByPost) {
    lines.push(line("SPEED_POST", FEE_TABLE.SPEED_POST));
  }

  const totalPaise = lines.reduce((sum, item) => sum + item.amountPaise, 0);
  return { lines, totalPaise, ineligibleReason };
}

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

/** Services that never require the citizen to attend a test. */
export function requiresTest(service: Service): boolean {
  return service === "LL_NEW" || service === "LL_ADD_COV" || service === "DL_NEW" || service === "DL_ADD_COV";
}
