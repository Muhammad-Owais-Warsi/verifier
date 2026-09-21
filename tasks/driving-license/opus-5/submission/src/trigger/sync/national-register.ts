import { logger, schedules, task } from "@trigger.dev/sdk";
import type { Licence } from "../../lib/domain";
import { ManualInterventionRequired, TransientUpstreamError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import type { NrLicenceRecord } from "../../lib/providers/registries";
import { sarathiNr, vahan } from "../../lib/providers/registries";
import { store } from "../../lib/store";
import { nowIso } from "../../lib/time";
import { bulkQueue, enforcementQueue, nationalRegisterQueue, PRIORITY, TTL } from "../queues";

/**
 * Keeping the state register and the National Register in step.
 *
 * Two systems, both authoritative about different things, neither able to lock
 * the other. The rules that make that tractable:
 *
 *  - Writes are conditional on the revision we last observed. A blind
 *    last-writer-wins push would silently erase another state's update.
 *  - Enforcement outcomes always win. If the National Register says a licence
 *    is suspended and we think it is active, we are wrong — a suspension we
 *    overwrite is a disqualified driver back on the road.
 *  - Anything the merge rules cannot decide stops and waits for a human rather
 *    than picking a side.
 */

export const lookupNationalRegister = task({
  id: "sync.nr-lookup",
  queue: nationalRegisterQueue,
  ttl: TTL.INTERACTIVE,
  maxDuration: 60,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 20_000, randomize: true },
  run: async (payload: { demographicHash: string }, { signal }): Promise<NrLicenceRecord | undefined> => {
    return sarathiNr.findExistingLicence({ demographicHash: payload.demographicHash, signal });
  },
});

export const checkEnforcement = task({
  id: "sync.enforcement-check",
  queue: enforcementQueue,
  ttl: TTL.INTERACTIVE,
  maxDuration: 60,
  retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 20_000, randomize: true },
  run: async (payload: { dlNumber: string }, { signal }): Promise<{ blocked: boolean; reason: string }> => {
    const summary = await vahan.challans(payload.dlNumber, signal);
    const now = Date.now();

    if (summary.disqualifiedTill && new Date(summary.disqualifiedTill).getTime() > now) {
      return { blocked: true, reason: `Court disqualification in force until ${summary.disqualifiedTill}` };
    }
    if (summary.suspendedTill && new Date(summary.suspendedTill).getTime() > now) {
      return { blocked: true, reason: `Licence suspended until ${summary.suspendedTill}` };
    }
    // Unpaid challans do not block a service by themselves; they are surfaced
    // to the officer and to the citizen.
    return { blocked: false, reason: `${summary.pendingCount} pending challan(s)` };
  },
});

export const pushToNationalRegister = task({
  id: "sync.nr-push",
  queue: nationalRegisterQueue,
  maxDuration: 120,
  retry: { maxAttempts: 6, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 120_000, randomize: true },
  run: async (payload: { dlNumber: string }, { ctx, signal }) => {
    const licence = await store.getLicence(payload.dlNumber);
    if (!licence) {
      throw new ManualInterventionRequired(payload.dlNumber, "Push requested for a licence that does not exist locally");
    }

    const result = await sarathiNr.pushLicence({
      record: toRecord(licence),
      expectedRevision: licence.revision - 1,
      signal,
    });

    if (result.outcome === "APPLIED") {
      logger.info("National Register updated", { dlNumber: payload.dlNumber, revision: result.revision });
      return { applied: true, revision: result.revision };
    }

    if (result.outcome === "STALE") {
      const merged = mergeLicence(licence, result.remote);
      await store.saveLicence(merged);
      // Re-push on the next attempt with the merged revision. Bounded by the
      // task's own retry budget; a register that keeps moving under us is a
      // real problem and should eventually surface as a failure.
      throw new TransientUpstreamError(
        "sarathi-nr",
        `stale revision (local ${licence.revision}, remote ${result.remote.revision}); merged and retrying`,
      );
    }

    await store.recordDeadLetter({
      id: newId("dlq"),
      kind: "sync.nr-push",
      reference: payload.dlNumber,
      payload: { local: toRecord(licence), remote: result.remote },
      error: result.reason,
      attempts: ctx.attempt.number,
      createdAt: nowIso(),
    });
    throw new ManualInterventionRequired(payload.dlNumber, `National Register conflict: ${result.reason}`);
  },
});

/**
 * Nightly delta pull. Other states issue, suspend and surrender licences that
 * we hold records for; without this our copy drifts and we start approving
 * services for people who are suspended elsewhere.
 *
 * Runs on the small bulk queue and in bounded pages, so a six-month backlog
 * catches up over several nights instead of monopolising the fleet for one.
 */
export const pullNationalRegisterDelta = schedules.task({
  id: "sync.nr-pull",
  cron: { pattern: "30 19 * * *", timezone: "Asia/Kolkata" },
  queue: bulkQueue,
  maxDuration: 900,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000, randomize: true },
  run: async () => {
    const stream = "nr-delta";
    const checkpoint = await store.getCheckpoint(stream);
    let cursor = checkpoint?.cursor;
    let applied = 0;
    let pages = 0;
    const MAX_PAGES = 200;
    const PAGE_SIZE = 500;

    while (pages < MAX_PAGES) {
      const page = await sarathiNr.fetchDelta({ cursor, limit: PAGE_SIZE });
      if (page.records.length === 0) break;

      await applyRecords.batchTrigger(
        page.records.map((record) => ({
          payload: { record },
          options: { priority: PRIORITY.BACKGROUND, ttl: TTL.BACKGROUND },
        })),
      );
      applied += page.records.length;
      pages += 1;

      if (!page.nextCursor) {
        cursor = undefined;
        break;
      }
      cursor = page.nextCursor;
      // The checkpoint advances per page, so an interrupted sweep resumes from
      // where it stopped rather than replaying the whole delta.
      await store.saveCheckpoint(stream, cursor);
    }

    logger.info("National Register delta pulled", { applied, pages });
    return { applied, pages };
  },
});

export const applyRecords = task({
  id: "sync.nr-apply",
  queue: bulkQueue,
  ttl: TTL.BACKGROUND,
  maxDuration: 60,
  retry: { maxAttempts: 3 },
  run: async (payload: { record: NrLicenceRecord }) => {
    const local = await store.getLicence(payload.record.dlNumber);
    if (!local) {
      await store.saveLicence(fromRecord(payload.record));
      return { action: "INSERTED" };
    }
    if (payload.record.revision <= local.revision && !isEnforcementStatus(payload.record.status)) {
      return { action: "IGNORED_STALE" };
    }
    await store.saveLicence(mergeLicence(local, payload.record));
    return { action: "MERGED" };
  },
});

function isEnforcementStatus(status: Licence["status"]): boolean {
  return status === "SUSPENDED" || status === "DISQUALIFIED";
}

/**
 * Merge policy, in priority order: an enforcement status from either side
 * sticks, then the higher revision wins for everything else.
 */
function mergeLicence(local: Licence, remote: NrLicenceRecord): Licence {
  const status = isEnforcementStatus(remote.status)
    ? remote.status
    : isEnforcementStatus(local.status)
      ? local.status
      : remote.revision > local.revision
        ? remote.status
        : local.status;

  const winner = remote.revision > local.revision ? remote : local;
  return {
    ...local,
    status,
    covs: winner.covs,
    validTill: winner.validTill,
    rtoCode: remote.revision > local.revision ? remote.rtoCode : local.rtoCode,
    revision: Math.max(local.revision, remote.revision) + 1,
    updatedAt: nowIso(),
  };
}

function toRecord(licence: Licence): NrLicenceRecord {
  return {
    dlNumber: licence.number,
    citizenId: licence.citizenId,
    state: licence.rtoCode.slice(0, 2),
    rtoCode: licence.rtoCode,
    covs: licence.covs,
    status: licence.status,
    validTill: licence.validTill,
    revision: licence.revision,
    updatedAt: licence.updatedAt,
  };
}

function fromRecord(record: NrLicenceRecord): Licence {
  return {
    number: record.dlNumber,
    citizenId: record.citizenId,
    rtoCode: record.rtoCode,
    covs: record.covs,
    issuedAt: record.updatedAt,
    validTill: record.validTill,
    status: record.status,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}
