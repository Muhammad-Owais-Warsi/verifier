import { AbortTaskRunError } from "@trigger.dev/sdk";

/**
 * Error taxonomy. The only thing the runtime needs to know is "retry or don't",
 * so everything either extends Error (retryable, the default) or is funnelled
 * through AbortTaskRunError (permanent, burns no further attempts).
 */

/** A downstream system is unhealthy but the request is valid. Safe to retry. */
export class TransientUpstreamError extends Error {
  constructor(
    readonly system: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${system}] ${message}`);
    this.name = "TransientUpstreamError";
  }
}

/** The request itself is wrong. Retrying will produce the same answer. */
export class PermanentValidationError extends AbortTaskRunError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PermanentValidationError";
  }
}

/** The citizen exceeded a fair-use limit. Not an outage, not a bug. */
export class QuotaExceededError extends AbortTaskRunError {
  constructor(
    readonly subject: string,
    readonly limit: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Fair-use limit '${limit}' exhausted for ${subject}; retry after ${retryAfterSeconds}s`);
    this.name = "QuotaExceededError";
  }
}

/**
 * A state transition was attempted that the application's current state does not
 * allow. Almost always means a duplicate/late event; the caller should treat it
 * as a no-op rather than an incident.
 */
export class InvalidTransitionError extends AbortTaskRunError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal application transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Optimistic concurrency lost. Retrying re-reads and usually succeeds. */
export class StaleWriteError extends Error {
  constructor(entity: string, id: string) {
    super(`Stale write to ${entity} ${id}`);
    this.name = "StaleWriteError";
  }
}

/** Money is in a state a machine must not resolve on its own. */
export class ManualInterventionRequired extends AbortTaskRunError {
  constructor(
    readonly reference: string,
    message: string,
  ) {
    super(`Manual intervention required (${reference}): ${message}`);
    this.name = "ManualInterventionRequired";
  }
}

export function isRetryable(error: unknown): boolean {
  return !(error instanceof AbortTaskRunError);
}
