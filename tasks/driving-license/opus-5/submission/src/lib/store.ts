import type {
  Application,
  ApplicationStatus,
  DeliveryStatus,
  FeeLine,
  FeePurpose,
  Licence,
  NotificationChannel,
  NotificationEvent,
  Payment,
  PaymentStatus,
  Slot,
  SlotHold,
} from "./domain";
import { StaleWriteError } from "./errors";
import { canTransition, isReplay } from "./state-machine";
import { istDateKey, nowIso } from "./time";

/**
 * Persistence boundary.
 *
 * The implementation below is an in-process reference store so the whole system
 * is runnable and readable in one repo. Every method is written to the contract
 * a sharded Postgres would honour — conditional updates keyed on a version,
 * single-statement counter increments, claim-then-act for anything that hands
 * out a scarce resource — so swapping the class out for a real driver does not
 * change a single caller. Nothing here relies on holding state across processes
 * beyond what a real database would provide.
 */

export type ClaimResult = "CLAIMED" | "ALREADY_CLAIMED";

export type TokenBucketResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller may retry, when the bucket is empty. */
  retryAfterSeconds: number;
};

export type NotificationRecord = {
  id: string;
  citizenId: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  status: DeliveryStatus;
  providerMessageId?: string;
  provider?: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
};

export type DeadLetter = {
  id: string;
  kind: string;
  reference: string;
  payload: unknown;
  error: string;
  attempts: number;
  createdAt: string;
  resolvedAt?: string;
};

export type SyncCheckpoint = {
  stream: string;
  cursor: string;
  updatedAt: string;
};

export type CitizenContact = {
  citizenId: string;
  mobile: string;
  email?: string;
  language: string;
};

export type NotificationPreferences = {
  citizenId: string;
  language: string;
  smsOptOut: boolean;
  emailOptOut: boolean;
  pushTokens: string[];
  /** Number registered on the TRAI DND registry. */
  dndRegistered: boolean;
};

class InMemoryStore {
  private readonly applications = new Map<string, Application>();
  private readonly payments = new Map<string, Payment>();
  private readonly paymentsByIdempotency = new Map<string, string>();
  private readonly paymentsByOrderId = new Map<string, string>();
  private readonly seenGatewayEvents = new Set<string>();
  private readonly slots = new Map<string, Slot>();
  private readonly holds = new Map<string, SlotHold>();
  private readonly licences = new Map<string, Licence>();
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly notificationDedupe = new Map<string, number>();
  private readonly preferences = new Map<string, NotificationPreferences>();
  private readonly contacts = new Map<string, CitizenContact>();
  private readonly buckets = new Map<string, { tokens: number; refilledAt: number }>();
  private readonly claims = new Map<string, number>();
  private readonly deadLetters = new Map<string, DeadLetter>();
  private readonly checkpoints = new Map<string, SyncCheckpoint>();
  private readonly testAttempts = new Map<string, number>();

  // ---------------------------------------------------------------- applications

  async getApplication(id: string): Promise<Application | undefined> {
    return this.applications.get(id);
  }

  /**
   * The portal generates the application id, so a resubmitted form or a retried
   * run reuses the existing row instead of creating a second application.
   */
  async createApplicationIfAbsent(application: Application): Promise<{ application: Application; created: boolean }> {
    const existing = this.applications.get(application.id);
    if (existing) return { application: existing, created: false };
    this.applications.set(application.id, application);
    return { application, created: true };
  }

  async saveApplication(application: Application): Promise<Application> {
    this.applications.set(application.id, application);
    return application;
  }

  /**
   * Conditional status write. Returns `undefined` when the transition is a
   * replay of one already applied, which is the common case for duplicate
   * webhooks and retried runs; throws only when the move is genuinely illegal
   * or when another writer won the race.
   */
  async transitionApplication(
    id: string,
    to: ApplicationStatus,
    options: { reason: string; expectedVersion?: number; patch?: Partial<Application> } = { reason: "" },
  ): Promise<Application | undefined> {
    const current = this.applications.get(id);
    if (!current) throw new StaleWriteError("application", id);
    if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new StaleWriteError("application", id);
    }
    if (isReplay(current.status, to)) return undefined;
    if (!canTransition(current.status, to)) return undefined;

    const next: Application = {
      ...current,
      ...options.patch,
      status: to,
      version: current.version + 1,
      updatedAt: nowIso(),
      history: [...current.history, { at: nowIso(), from: current.status, to, reason: options.reason }],
    };
    this.applications.set(id, next);
    return next;
  }

  async patchApplication(id: string, patch: Partial<Application>): Promise<Application> {
    const current = this.applications.get(id);
    if (!current) throw new StaleWriteError("application", id);
    const next: Application = { ...current, ...patch, version: current.version + 1, updatedAt: nowIso() };
    this.applications.set(id, next);
    return next;
  }

  async listApplicationsOlderThan(cutoffIso: string, statuses: ApplicationStatus[]): Promise<Application[]> {
    return [...this.applications.values()].filter(
      (application) => statuses.includes(application.status) && application.updatedAt < cutoffIso,
    );
  }

  // -------------------------------------------------------------------- payments

  /**
   * Create-or-return keyed on the caller's idempotency key. Two browser tabs
   * submitting the same fee produce one payment row, which is the first line of
   * defence against double charging.
   */
  async createPaymentIfAbsent(input: {
    id: string;
    idempotencyKey: string;
    applicationId: string;
    citizenId: string;
    purpose: FeePurpose;
    lines: FeeLine[];
  }): Promise<{ payment: Payment; created: boolean }> {
    const existingId = this.paymentsByIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.payments.get(existingId);
      if (existing) return { payment: existing, created: false };
    }
    const payment: Payment = {
      id: input.id,
      applicationId: input.applicationId,
      citizenId: input.citizenId,
      purpose: input.purpose,
      status: "CREATED",
      lines: input.lines,
      amountPaise: input.lines.reduce((sum, item) => sum + item.amountPaise, 0),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      version: 1,
    };
    this.payments.set(payment.id, payment);
    this.paymentsByIdempotency.set(input.idempotencyKey, payment.id);
    return { payment, created: true };
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    return this.payments.get(id);
  }

  async updatePayment(id: string, patch: Partial<Payment>, expectedVersion?: number): Promise<Payment> {
    const current = this.payments.get(id);
    if (!current) throw new StaleWriteError("payment", id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new StaleWriteError("payment", id);
    }
    const next: Payment = { ...current, ...patch, version: current.version + 1, updatedAt: nowIso() };
    this.payments.set(id, next);
    if (next.gatewayOrderId) this.paymentsByOrderId.set(next.gatewayOrderId, next.id);
    return next;
  }

  /** Webhooks and settlement rows only know the gateway's own order id. */
  async findPaymentByOrderId(orderId: string): Promise<Payment | undefined> {
    const id = this.paymentsByOrderId.get(orderId);
    return id ? this.payments.get(id) : undefined;
  }

  /**
   * Gateway events arrive more than once and out of order. Recording the event
   * id before acting on it turns every handler into an at-most-once processor.
   */
  async claimGatewayEvent(eventId: string): Promise<ClaimResult> {
    if (this.seenGatewayEvents.has(eventId)) return "ALREADY_CLAIMED";
    this.seenGatewayEvents.add(eventId);
    return "CLAIMED";
  }

  async listPaymentsByStatus(statuses: PaymentStatus[], olderThanIso?: string): Promise<Payment[]> {
    return [...this.payments.values()].filter(
      (payment) => statuses.includes(payment.status) && (!olderThanIso || payment.updatedAt < olderThanIso),
    );
  }

  /** Every capture the gateway has reported for an application, refunds aside. */
  async listCapturedPaymentsForApplication(applicationId: string): Promise<Payment[]> {
    return [...this.payments.values()].filter(
      (payment) => payment.applicationId === applicationId && payment.status === "CAPTURED",
    );
  }

  // ----------------------------------------------------------------------- slots

  async upsertSlot(slot: Slot): Promise<void> {
    this.slots.set(slot.id, slot);
  }

  async getSlot(id: string): Promise<Slot | undefined> {
    return this.slots.get(id);
  }

  async listOpenSlots(rtoCode: string, kind: Slot["kind"], fromIso: string, limit = 20): Promise<Slot[]> {
    return [...this.slots.values()]
      .filter(
        (slot) =>
          slot.rtoCode === rtoCode && slot.kind === kind && slot.startsAt >= fromIso && slot.booked < slot.capacity,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, limit);
  }

  /**
   * Reserve one seat. The increment and the capacity check happen together, so
   * two citizens racing for the last seat cannot both win.
   */
  async holdSlot(input: {
    holdId: string;
    slotId: string;
    applicationId: string;
    citizenId: string;
    expiresAt: string;
  }): Promise<SlotHold | undefined> {
    const slot = this.slots.get(input.slotId);
    if (!slot || slot.booked >= slot.capacity) return undefined;
    this.slots.set(slot.id, { ...slot, booked: slot.booked + 1, status: "HELD" });
    const hold: SlotHold = {
      id: input.holdId,
      slotId: input.slotId,
      applicationId: input.applicationId,
      citizenId: input.citizenId,
      expiresAt: input.expiresAt,
      released: false,
    };
    this.holds.set(hold.id, hold);
    return hold;
  }

  async confirmHold(holdId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold) return;
    const slot = this.slots.get(hold.slotId);
    if (slot) this.slots.set(slot.id, { ...slot, status: "BOOKED" });
  }

  /** Idempotent: releasing an already-released hold must not free a second seat. */
  async releaseHold(holdId: string): Promise<boolean> {
    const hold = this.holds.get(holdId);
    if (!hold || hold.released) return false;
    this.holds.set(holdId, { ...hold, released: true });
    const slot = this.slots.get(hold.slotId);
    if (slot) {
      this.slots.set(slot.id, { ...slot, booked: Math.max(0, slot.booked - 1), status: "OPEN" });
    }
    return true;
  }

  async listExpiredHolds(nowIsoValue: string, limit = 500): Promise<SlotHold[]> {
    return [...this.holds.values()].filter((hold) => !hold.released && hold.expiresAt < nowIsoValue).slice(0, limit);
  }

  // -------------------------------------------------------------------- licences

  async getLicence(number: string): Promise<Licence | undefined> {
    return this.licences.get(number);
  }

  async saveLicence(licence: Licence): Promise<Licence> {
    this.licences.set(licence.number, licence);
    return licence;
  }

  async listLicencesExpiringOn(dateKey: string): Promise<Licence[]> {
    return [...this.licences.values()].filter(
      (licence) => licence.status === "ACTIVE" && licence.validTill.slice(0, 10) === dateKey,
    );
  }

  /** Monotonic per-RTO, per-year serial used to mint licence numbers. */
  async nextLicenceSerial(rtoCode: string, year: number): Promise<number> {
    const key = `serial:${rtoCode}:${year}`;
    const next = (this.claims.get(key) ?? 0) + 1;
    this.claims.set(key, next);
    return next;
  }

  async nextTestAttempt(applicationId: string): Promise<number> {
    const attempt = (this.testAttempts.get(applicationId) ?? 0) + 1;
    this.testAttempts.set(applicationId, attempt);
    return attempt;
  }

  async getTestAttempt(applicationId: string): Promise<number> {
    return this.testAttempts.get(applicationId) ?? 0;
  }

  // --------------------------------------------------------------- notifications

  /**
   * Contact details, kept separately from the application so a sweep that
   * touches a licence issued years ago can still reach the citizen.
   */
  async saveContact(contact: CitizenContact): Promise<void> {
    this.contacts.set(contact.citizenId, contact);
  }

  async getContact(citizenId: string): Promise<CitizenContact | undefined> {
    return this.contacts.get(citizenId);
  }

  async getPreferences(citizenId: string): Promise<NotificationPreferences> {
    return (
      this.preferences.get(citizenId) ?? {
        citizenId,
        language: "en",
        smsOptOut: false,
        emailOptOut: false,
        pushTokens: [],
        dndRegistered: false,
      }
    );
  }

  async savePreferences(preferences: NotificationPreferences): Promise<void> {
    this.preferences.set(preferences.citizenId, preferences);
  }

  /**
   * Suppresses a repeat of the same message to the same person within the
   * window. Returns ALREADY_CLAIMED for the duplicate.
   */
  async claimNotification(dedupeKey: string, windowSeconds: number): Promise<ClaimResult> {
    const now = Date.now();
    const seenAt = this.notificationDedupe.get(dedupeKey);
    if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) return "ALREADY_CLAIMED";
    this.notificationDedupe.set(dedupeKey, now);
    return "CLAIMED";
  }

  async recordNotification(record: NotificationRecord): Promise<void> {
    this.notifications.set(record.id, record);
  }

  async updateNotification(id: string, patch: Partial<NotificationRecord>): Promise<void> {
    const current = this.notifications.get(id);
    if (!current) return;
    this.notifications.set(id, { ...current, ...patch, updatedAt: nowIso() });
  }

  // --------------------------------------------------------------------- quotas

  /**
   * Token bucket with lazy refill. `capacity` tokens, refilled at
   * `refillPerSecond`; a caller that empties its bucket is told how long to wait
   * rather than being retried into the ground.
   */
  async consumeToken(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost = 1,
  ): Promise<TokenBucketResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, refilledAt: now };
    const elapsedSeconds = (now - bucket.refilledAt) / 1000;
    const tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);

    if (tokens < cost) {
      this.buckets.set(key, { tokens, refilledAt: now });
      return {
        allowed: false,
        remaining: Math.floor(tokens),
        retryAfterSeconds: Math.ceil((cost - tokens) / Math.max(refillPerSecond, 1e-9)),
      };
    }
    this.buckets.set(key, { tokens: tokens - cost, refilledAt: now });
    return { allowed: true, remaining: Math.floor(tokens - cost), retryAfterSeconds: 0 };
  }

  /** Per-calendar-day counter in IST, used for the hard daily caps. */
  async consumeDailyQuota(subject: string, name: string, limit: number): Promise<TokenBucketResult> {
    const key = `daily:${name}:${subject}:${istDateKey()}`;
    const used = this.claims.get(key) ?? 0;
    if (used >= limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: secondsUntilNextIstMidnight() };
    }
    this.claims.set(key, used + 1);
    return { allowed: true, remaining: limit - used - 1, retryAfterSeconds: 0 };
  }

  /** Generic once-only marker, e.g. "this licence was pushed to DigiLocker". */
  async claimOnce(key: string): Promise<ClaimResult> {
    if (this.claims.has(key)) return "ALREADY_CLAIMED";
    this.claims.set(key, 1);
    return "CLAIMED";
  }

  // ---------------------------------------------------------- dlq + checkpoints

  async recordDeadLetter(entry: DeadLetter): Promise<void> {
    this.deadLetters.set(entry.id, entry);
  }

  async listDeadLetters(kind?: string, limit = 200): Promise<DeadLetter[]> {
    return [...this.deadLetters.values()]
      .filter((entry) => !entry.resolvedAt && (!kind || entry.kind === kind))
      .slice(0, limit);
  }

  async resolveDeadLetter(id: string): Promise<void> {
    const entry = this.deadLetters.get(id);
    if (entry) this.deadLetters.set(id, { ...entry, resolvedAt: nowIso() });
  }

  async getCheckpoint(stream: string): Promise<SyncCheckpoint | undefined> {
    return this.checkpoints.get(stream);
  }

  async saveCheckpoint(stream: string, cursor: string): Promise<void> {
    this.checkpoints.set(stream, { stream, cursor, updatedAt: nowIso() });
  }
}

function secondsUntilNextIstMidnight(): number {
  const now = new Date();
  const istNow = new Date(now.getTime() + 330 * 60_000);
  const midnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1);
  return Math.ceil((midnight - istNow.getTime()) / 1000);
}

export const store = new InMemoryStore();
export type Store = InMemoryStore;
