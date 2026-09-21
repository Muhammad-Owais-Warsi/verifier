/**
 * Everything citizen-facing runs on IST. Workers may be anywhere, so no code
 * outside this file is allowed to use the host timezone.
 */

export const IST_OFFSET_MINUTES = 330;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Wall-clock parts in IST for a given instant. */
export function istParts(instant: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** `YYYY-MM-DD` in IST — the bucket key for all per-day quotas. */
export function istDateKey(instant: Date = new Date()): string {
  const { year, month, day } = istParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * TRAI restricts non-transactional traffic to 09:00–21:00 IST. Transactional
 * messages are exempt, which is why the caller passes the category in.
 */
export const QUIET_HOURS_START_IST = 21;
export const QUIET_HOURS_END_IST = 9;

export function isQuietHours(instant: Date = new Date()): boolean {
  const { hour } = istParts(instant);
  return hour >= QUIET_HOURS_START_IST || hour < QUIET_HOURS_END_IST;
}

/** Next instant at which a deferrable message may be delivered. */
export function nextDeliveryWindow(instant: Date = new Date()): Date {
  if (!isQuietHours(instant)) return instant;
  const { hour } = istParts(instant);
  const hoursUntilNineAm = hour >= QUIET_HOURS_START_IST ? 24 - hour + QUIET_HOURS_END_IST : QUIET_HOURS_END_IST - hour;
  const target = new Date(instant.getTime() + hoursUntilNineAm * 60 * MINUTE_MS);
  // Land a few minutes into the window rather than exactly on the boundary, so a
  // nationwide backlog does not all fire on the same second.
  return new Date(target.getTime() - istParts(target).minute * MINUTE_MS + Math.floor(Math.random() * 15) * MINUTE_MS);
}

/** RTOs are shut on Sundays and on the second Saturday of the month. */
export function isRtoWorkingDay(instant: Date): boolean {
  const { day, weekday } = istParts(instant);
  if (weekday === 0) return false;
  if (weekday === 6 && day > 7 && day <= 14) return false;
  return true;
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export function ageInYears(dateOfBirth: string, at: Date = new Date()): number {
  const dob = new Date(dateOfBirth);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

/**
 * Spreads a large fan-out over a window so a scheduled sweep does not deliver a
 * million messages in the same second. Deterministic in the key so retries of
 * the same item reuse the same offset.
 */
export function jitterSeconds(key: string, windowSeconds: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % Math.max(1, windowSeconds);
}
