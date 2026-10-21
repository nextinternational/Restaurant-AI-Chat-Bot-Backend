import { MongoServerError, ObjectId } from "mongodb";
import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import type { RestaurantId } from "../domain/ids.js";
import {
  auditLogSchema, membershipSchema, planSchema, restaurantSchema, sessionSchema, subscriptionSchema, userSchema, widgetKeySchema,
  type Membership, type Plan, type Restaurant, type Subscription, type User, type UserSession,
} from "../domain/schemas.js";
import type { Role } from "../auth/permissions.js";
import { generateWidgetKey } from "../security/tokens.js";

export class EmailTakenError extends Error {
  constructor() {
    super("email already registered");
    this.name = "EmailTakenError";
  }
}

export class SlugTakenError extends Error {
  constructor() {
    super("restaurant slug already in use");
    this.name = "SlugTakenError";
  }
}

export class MembershipExistsError extends Error {
  constructor() {
    super("user already belongs to this restaurant");
    this.name = "MembershipExistsError";
  }
}

/** Operator-driven onboarding (CLI): no subscription, no self-service. `user` is set only when the user is new. */
export interface NewProvision {
  user?: User;
  restaurant: Restaurant;
  membership: Membership;
}

export interface NewMember {
  user?: User;
  membership: Membership;
}

export interface NewAccount {
  user: User;
  restaurant: Restaurant;
  membership: Membership;
  subscription: Subscription;
}

export interface UserMembership {
  membership: Membership;
  restaurant: Pick<Restaurant, "restaurantId" | "name" | "slug" | "status">;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: Membership["status"];
}

export interface AuditEntry {
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  createdAt: Date;
}

export interface WidgetKeyView {
  keyId: string;
  publicKey: string;
  label?: string;
  allowedOrigins: string[];
  status: "active" | "revoked";
  createdAt: Date;
  revokedAt?: Date;
}

export interface RestaurantPatch {
  name?: string;
  timezone?: string;
  defaultLocale?: string;
}

/** Operator-set facts the chat assistant may state (including the contact phone number) and the AI spend cap. */
export interface RestaurantSettingsPatch {
  location?: NonNullable<Restaurant["location"]>;
  monthlyAiBudgetMicros?: number;
}

/**
 * Everything the account/SaaS layer needs from storage. Services depend on this interface, so the
 * HTTP layer is testable without MongoDB and the Mongo code stays inside src/repositories (where
 * raw collections are allowed by the tenancy lint rule).
 *
 * Tenant-owned data is always reached through a restaurantId that the SERVER has verified against the
 * caller's membership; the MongoDB implementation binds it with ScopedCollection.
 */
export interface AccountStore {
  /** Creates user + restaurant + owner membership + subscription. Throws EmailTakenError on duplicate email. */
  createAccount(account: NewAccount): Promise<void>;
  /** Internal provisioning: restaurant + owner membership (+ user if new). Throws EmailTakenError / SlugTakenError. */
  provisionRestaurant(input: NewProvision): Promise<void>;
  /** Internal provisioning: staff member for an existing restaurant. Throws EmailTakenError / MembershipExistsError. */
  addMember(input: NewMember): Promise<void>;
  findRestaurantBySlug(slug: string): Promise<Restaurant | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(userId: string): Promise<User | null>;

  createSession(session: UserSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<UserSession | null>;
  touchSession(tokenHash: string, now: Date): Promise<void>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  revokeAllSessions(userId: string, now: Date): Promise<void>;

  listMembershipsForUser(userId: string): Promise<UserMembership[]>;
  getMembership(userId: string, restaurantId: RestaurantId): Promise<Membership | null>;

  getRestaurant(restaurantId: RestaurantId): Promise<Restaurant | null>;
  updateRestaurant(restaurantId: RestaurantId, patch: RestaurantPatch, now: Date): Promise<Restaurant | null>;
  updateRestaurantSettings(restaurantId: RestaurantId, patch: RestaurantSettingsPatch, now: Date): Promise<Restaurant | null>;
  listTeam(restaurantId: RestaurantId): Promise<TeamMember[]>;
  getSubscription(restaurantId: RestaurantId): Promise<{ subscription: Subscription; plan: Plan | null } | null>;
  getPlan(code: string): Promise<Plan | null>;

  recordAudit(restaurantId: RestaurantId, entry: AuditEntry, now: Date): Promise<void>;
  listAudit(restaurantId: RestaurantId, opts: { limit: number; before?: Date }): Promise<AuditRecord[]>;

  createWidgetKey(restaurantId: RestaurantId, input: { allowedOrigins: string[]; label?: string }, now: Date): Promise<WidgetKeyView>;
  listWidgetKeys(restaurantId: RestaurantId): Promise<WidgetKeyView[]>;
  revokeWidgetKey(restaurantId: RestaurantId, keyId: string, now: Date): Promise<boolean>;
}

const isDuplicateKey = (err: unknown): boolean => err instanceof MongoServerError && err.code === 11000;
function stripTenant<T extends { restaurantId: unknown }>(doc: T): Omit<T, "restaurantId"> {
  const copy: Partial<T> = { ...doc };
  delete copy.restaurantId;
  return copy as Omit<T, "restaurantId">;
}
const HEX24 = /^[0-9a-f]{24}$/;

export class MongoAccountStore implements AccountStore {
  constructor(private readonly cols: Collections) {}

  // ------------------------------------------------------------------ onboarding
  async createAccount(input: NewAccount): Promise<void> {
    const user = userSchema.parse(input.user);
    const restaurant = restaurantSchema.parse(input.restaurant);
    const membership = membershipSchema.parse(input.membership);
    const subscription = subscriptionSchema.parse(input.subscription);
    const { restaurantId } = restaurant;

    try {
      await this.cols.users.insertOne(user);
    } catch (err) {
      if (isDuplicateKey(err)) throw new EmailTakenError();
      throw err;
    }

    // No multi-document transaction: local single-node MongoDB has none. Instead, a failure part-way
    // removes everything created for THIS signup (best effort) so no half-built tenant is left behind.
    try {
      // ScopedCollection stamps the tenant itself and refuses documents that carry their own restaurantId.
      await new ScopedCollection(this.cols.restaurants, restaurantId).insertOne(stripTenant(restaurant));
      await new ScopedCollection(this.cols.memberships, restaurantId).insertOne(stripTenant(membership));
      await new ScopedCollection(this.cols.subscriptions, restaurantId).insertOne(stripTenant(subscription));
    } catch (err) {
      await Promise.allSettled([
        this.cols.users.deleteOne({ userId: user.userId }),
        this.cols.restaurants.deleteOne({ restaurantId }),
        this.cols.memberships.deleteMany({ restaurantId }),
        this.cols.subscriptions.deleteMany({ restaurantId }),
      ]);
      throw err;
    }
  }

  async provisionRestaurant(input: NewProvision): Promise<void> {
    const user = input.user ? userSchema.parse(input.user) : undefined;
    const restaurant = restaurantSchema.parse(input.restaurant);
    const membership = membershipSchema.parse(input.membership);
    const { restaurantId } = restaurant;

    if (user) {
      try {
        await this.cols.users.insertOne(user);
      } catch (err) {
        if (isDuplicateKey(err)) throw new EmailTakenError();
        throw err;
      }
    }
    try {
      try {
        await new ScopedCollection(this.cols.restaurants, restaurantId).insertOne(stripTenant(restaurant));
      } catch (err) {
        if (isDuplicateKey(err)) throw new SlugTakenError();
        throw err;
      }
      await new ScopedCollection(this.cols.memberships, restaurantId).insertOne(stripTenant(membership));
    } catch (err) {
      // Best-effort cleanup (no multi-document transactions on a single-node MongoDB). Only what THIS call created.
      await Promise.allSettled([
        ...(user ? [this.cols.users.deleteOne({ userId: user.userId })] : []),
        this.cols.restaurants.deleteOne({ restaurantId }),
        this.cols.memberships.deleteMany({ restaurantId }),
      ]);
      throw err;
    }
  }

  async addMember(input: NewMember): Promise<void> {
    const user = input.user ? userSchema.parse(input.user) : undefined;
    const membership = membershipSchema.parse(input.membership);
    if (user) {
      try {
        await this.cols.users.insertOne(user);
      } catch (err) {
        if (isDuplicateKey(err)) throw new EmailTakenError();
        throw err;
      }
    }
    try {
      await new ScopedCollection(this.cols.memberships, membership.restaurantId).insertOne(stripTenant(membership));
    } catch (err) {
      if (user) await this.cols.users.deleteOne({ userId: user.userId }).catch(() => undefined);
      if (isDuplicateKey(err)) throw new MembershipExistsError();
      throw err;
    }
  }

  async findRestaurantBySlug(slug: string): Promise<Restaurant | null> {
    if (typeof slug !== "string") return null;
    const doc = await this.cols.restaurants.findOne({ slug });
    return doc ? restaurantSchema.parse(doc) : null;
  }

  // ------------------------------------------------------------------ users & sessions
  async findUserByEmail(email: string): Promise<User | null> {
    if (typeof email !== "string") return null; // never let an object like {"$ne": null} reach the query
    const doc = await this.cols.users.findOne({ email: email.toLowerCase() });
    return doc ? userSchema.parse(doc) : null;
  }

  async findUserById(userId: string): Promise<User | null> {
    if (typeof userId !== "string") return null;
    const doc = await this.cols.users.findOne({ userId });
    return doc ? userSchema.parse(doc) : null;
  }

  async createSession(session: UserSession): Promise<void> {
    await this.cols.sessions.insertOne(sessionSchema.parse(session));
  }

  async findSessionByTokenHash(tokenHash: string): Promise<UserSession | null> {
    if (typeof tokenHash !== "string") return null;
    const doc = await this.cols.sessions.findOne({ tokenHash });
    return doc ? sessionSchema.parse(doc) : null;
  }

  async touchSession(tokenHash: string, now: Date): Promise<void> {
    await this.cols.sessions.updateOne({ tokenHash }, { $set: { lastSeenAt: now } });
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.cols.sessions.updateOne({ tokenHash, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
  }

  async revokeAllSessions(userId: string, now: Date): Promise<void> {
    await this.cols.sessions.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: now } });
  }

  // ------------------------------------------------------------------ memberships (tenant discovery for logged-in users)
  async listMembershipsForUser(userId: string): Promise<UserMembership[]> {
    const memberships = await this.cols.memberships.find({ userId, status: "active" }).limit(100).toArray();
    if (memberships.length === 0) return [];
    const restaurants = await this.cols.restaurants
      .find({ restaurantId: { $in: memberships.map((m) => m.restaurantId) } })
      .limit(100)
      .toArray();
    const byId = new Map(restaurants.map((r) => [r.restaurantId as string, restaurantSchema.parse(r)]));
    const out: UserMembership[] = [];
    for (const m of memberships) {
      const r = byId.get(m.restaurantId);
      if (!r) continue;
      out.push({
        membership: membershipSchema.parse(m),
        restaurant: { restaurantId: r.restaurantId, name: r.name, slug: r.slug, status: r.status },
      });
    }
    return out;
  }

  async getMembership(userId: string, restaurantId: RestaurantId): Promise<Membership | null> {
    const doc = await this.cols.memberships.findOne({ userId, restaurantId, status: "active" });
    return doc ? membershipSchema.parse(doc) : null;
  }

  // ------------------------------------------------------------------ tenant-scoped reads/writes
  async getRestaurant(restaurantId: RestaurantId): Promise<Restaurant | null> {
    const doc = await new ScopedCollection(this.cols.restaurants, restaurantId).findOne({});
    return doc ? restaurantSchema.parse(doc) : null;
  }

  async updateRestaurant(restaurantId: RestaurantId, patch: RestaurantPatch, now: Date): Promise<Restaurant | null> {
    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.defaultLocale !== undefined) set.defaultLocale = patch.defaultLocale;
    await new ScopedCollection(this.cols.restaurants, restaurantId).updateOne({}, { $set: set });
    return this.getRestaurant(restaurantId);
  }

  async updateRestaurantSettings(restaurantId: RestaurantId, patch: RestaurantSettingsPatch, now: Date): Promise<Restaurant | null> {
    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.location !== undefined) set.location = patch.location;
    if (patch.monthlyAiBudgetMicros !== undefined) set.monthlyAiBudgetMicros = patch.monthlyAiBudgetMicros;
    await new ScopedCollection(this.cols.restaurants, restaurantId).updateOne({}, { $set: set });
    return this.getRestaurant(restaurantId);
  }

  async listTeam(restaurantId: RestaurantId): Promise<TeamMember[]> {
    const memberships = await new ScopedCollection(this.cols.memberships, restaurantId).find({}, { limit: 100 });
    if (memberships.length === 0) return [];
    const users = await this.cols.users.find({ userId: { $in: memberships.map((m) => m.userId) } }).limit(100).toArray();
    const byId = new Map(users.map((u) => [u.userId, u]));
    const out: TeamMember[] = [];
    for (const m of memberships) {
      const u = byId.get(m.userId);
      if (!u) continue;
      // Explicit allow-list of fields: passwordHash can never leave through this path.
      out.push({ userId: u.userId, name: u.name, email: u.email, role: m.role, status: m.status });
    }
    return out;
  }

  async getSubscription(restaurantId: RestaurantId): Promise<{ subscription: Subscription; plan: Plan | null } | null> {
    const doc = await new ScopedCollection(this.cols.subscriptions, restaurantId).findOne({});
    if (!doc) return null;
    const subscription = subscriptionSchema.parse(doc);
    return { subscription, plan: await this.getPlan(subscription.planCode) };
  }

  async getPlan(code: string): Promise<Plan | null> {
    if (typeof code !== "string") return null;
    const doc = await this.cols.plans.findOne({ code });
    return doc ? planSchema.parse(doc) : null;
  }

  // ------------------------------------------------------------------ audit
  async recordAudit(restaurantId: RestaurantId, entry: AuditEntry, now: Date): Promise<void> {
    const doc = auditLogSchema.omit({ restaurantId: true }).parse({
      action: entry.action,
      resourceType: entry.resourceType,
      metadata: entry.metadata ?? {},
      createdAt: now,
      ...(entry.actorUserId !== undefined ? { actorUserId: entry.actorUserId } : {}),
      ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}),
    });
    await new ScopedCollection(this.cols.auditLogs, restaurantId).insertOne(doc);
  }

  async listAudit(restaurantId: RestaurantId, opts: { limit: number; before?: Date }): Promise<AuditRecord[]> {
    const filter = opts.before ? { createdAt: { $lt: opts.before } } : {};
    const rows = await new ScopedCollection(this.cols.auditLogs, restaurantId).find(filter, {
      limit: opts.limit,
      sort: { createdAt: -1 },
    });
    return rows.map((r) => {
      const a = auditLogSchema.parse(r);
      return {
        action: a.action,
        resourceType: a.resourceType,
        metadata: a.metadata,
        createdAt: a.createdAt,
        ...(a.actorUserId !== undefined ? { actorUserId: a.actorUserId } : {}),
        ...(a.resourceId !== undefined ? { resourceId: a.resourceId } : {}),
      };
    });
  }

  // ------------------------------------------------------------------ widget keys
  async createWidgetKey(restaurantId: RestaurantId, input: { allowedOrigins: string[]; label?: string }, now: Date): Promise<WidgetKeyView> {
    const doc = widgetKeySchema.omit({ restaurantId: true }).parse({
      publicKey: generateWidgetKey(),
      allowedOrigins: input.allowedOrigins,
      status: "active",
      createdAt: now,
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    const res = await new ScopedCollection(this.cols.widgetKeys, restaurantId).insertOne(doc);
    return toView(res.insertedId.toHexString(), doc);
  }

  async listWidgetKeys(restaurantId: RestaurantId): Promise<WidgetKeyView[]> {
    const rows = await new ScopedCollection(this.cols.widgetKeys, restaurantId).find({}, { limit: 50, sort: { createdAt: -1 } });
    return rows.map((r) => toView(r._id.toHexString(), widgetKeySchema.omit({ restaurantId: true }).parse(r)));
  }

  async revokeWidgetKey(restaurantId: RestaurantId, keyId: string, now: Date): Promise<boolean> {
    if (typeof keyId !== "string" || !HEX24.test(keyId)) return false;
    const res = await new ScopedCollection(this.cols.widgetKeys, restaurantId).updateOne(
      { _id: new ObjectId(keyId), status: "active" },
      { $set: { status: "revoked", revokedAt: now } },
    );
    return res.matchedCount > 0;
  }
}

function toView(keyId: string, d: Omit<ReturnType<typeof widgetKeySchema.parse>, "restaurantId">): WidgetKeyView {
  return {
    keyId,
    publicKey: d.publicKey,
    allowedOrigins: d.allowedOrigins,
    status: d.status,
    createdAt: d.createdAt,
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
  };
}

