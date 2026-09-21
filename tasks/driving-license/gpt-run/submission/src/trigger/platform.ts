import type { AdmissionLease } from "./contracts";

const baseUrl = process.env.PORTAL_INTERNAL_API_URL;
const serviceToken = process.env.PORTAL_INTERNAL_API_TOKEN;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Portal API returned ${status}: ${body}`);
  }
}

function configuration(): { baseUrl: string; serviceToken: string } {
  if (!baseUrl || !serviceToken) {
    throw new Error(
      "PORTAL_INTERNAL_API_URL and PORTAL_INTERNAL_API_TOKEN must be configured",
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), serviceToken };
}

export async function api<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const config = configuration();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${config.serviceToken}`,
      "content-type": "application/json",
      ...(options.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Capacity is granted atomically by the portal API. It enforces global,
 * per-user, and per-state quotas, preventing one account or region from
 * exhausting workers even when it submits many unique jobs.
 */
export async function withAdmission<T>(
  scope: string,
  userId: string,
  operation: (lease: AdmissionLease) => Promise<T>,
): Promise<T> {
  const lease = await api<AdmissionLease>("/v1/worker-leases", {
    method: "POST",
    body: { scope, userId, ttlSeconds: 300 },
  });

  try {
    return await operation(lease);
  } finally {
    await api<void>(`/v1/worker-leases/${encodeURIComponent(lease.leaseId)}/release`, {
      method: "POST",
    }).catch(() => undefined);
  }
}

export function isPermanent(error: unknown): boolean {
  return error instanceof HttpError && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 409 && error.status !== 429;
}
