import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/**
 * Stable hash used wherever a key must be identical across retries, processes
 * and deploys: idempotency keys, dedupe keys, shard selection.
 */
export function stableKey(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * Spreads a subject across N shards. Used to give each provider connection pool
 * its own concurrency lane so one hot citizen cannot pin a single lane.
 */
export function shardOf(subject: string, shards: number): number {
  const digest = createHash("sha256").update(subject).digest();
  return digest.readUInt32BE(0) % shards;
}

/**
 * Licence numbers follow the RTO format: two-letter state, two-digit RTO,
 * four-digit issue year, seven-digit serial.
 */
export function formatLicenceNumber(rtoCode: string, year: number, serial: number): string {
  return `${rtoCode.toUpperCase()}${year}${String(serial).padStart(7, "0")}`;
}

/** Redacts anything that must not reach logs or an OTEL span. */
export function maskMobile(mobile: string): string {
  return mobile.length <= 4 ? "****" : `${"*".repeat(mobile.length - 4)}${mobile.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}
