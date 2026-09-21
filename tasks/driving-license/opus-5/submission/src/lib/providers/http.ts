import { logger } from "@trigger.dev/sdk";
import { PermanentValidationError, TransientUpstreamError } from "../errors";

/**
 * One HTTP helper for every government/vendor integration, because the
 * retry decision has to be made the same way everywhere: 5xx, 429 and network
 * faults are transient and get thrown as errors the task runtime will retry;
 * 4xx is the caller's fault and aborts the run immediately.
 */

export type HttpRequest = {
  system: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Forwarded as Idempotency-Key; required for anything that moves money. */
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Task-level abort signal, so a cancelled run does not leave sockets open. */
  signal?: AbortSignal;
};

export type HttpResult<T> = {
  status: number;
  body: T;
  headers: Headers;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export async function httpJson<T>(request: HttpRequest): Promise<HttpResult<T>> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(request.idempotencyKey ? { "idempotency-key": request.idempotencyKey } : {}),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.any(signals),
    });
  } catch (cause) {
    // Connection reset, DNS failure, or our own timeout. All retryable, and all
    // ambiguous for non-idempotent calls — which is why every mutating request
    // above carries an idempotency key.
    throw new TransientUpstreamError(request.system, `transport failure after ${Date.now() - started}ms`, cause);
  }

  const text = await response.text();
  const body = text ? (safeJsonParse(text) as T) : ({} as T);

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    logger.warn("Upstream throttled us", { system: request.system, retryAfter });
    throw new TransientUpstreamError(request.system, `rate limited (retry-after=${retryAfter ?? "unset"})`);
  }
  if (response.status >= 500) {
    throw new TransientUpstreamError(request.system, `upstream ${response.status}`);
  }
  if (response.status >= 400) {
    throw new PermanentValidationError(
      `${request.system.toUpperCase()}_${response.status}`,
      typeof body === "object" && body !== null && "message" in body
        ? String((body as Record<string, unknown>).message)
        : text.slice(0, 500),
    );
  }

  return { status: response.status, body, headers: response.headers };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new PermanentValidationError("MISSING_CONFIG", `Environment variable ${name} is not set`);
  }
  return value;
}

export function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
