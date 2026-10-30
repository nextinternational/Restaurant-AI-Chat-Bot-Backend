import { randomBytes } from "node:crypto";
import type { RestaurantId } from "../../src/domain/ids.js";
import type { Membership, Plan, Restaurant, Subscription, User, UserSession } from "../../src/domain/schemas.js";
import {
  EmailTakenError, MembershipExistsError, SlugTakenError, type AccountStore, type NewMember, type NewProvision, type AuditRecord, type NewAccount, type RestaurantPatch, type RestaurantSettingsPatch, type TeamMember, type UserMembership, type WidgetKeyView,
} from "../../src/repositories/accountStore.js";

/** Test double with the same contract as MongoAccountStore (unique email, tenant-bound reads). */
export class MemoryAccountStore implements AccountStore {
  users: User[] = [];
  restaurants: Restaurant[] = [];
  memberships: Membership[] = [];
  subscriptions: Subscription[] = [];
  sessions: UserSession[] = [];
  audit: (AuditRecord & { restaurantId: string })[] = [];
  keys: (WidgetKeyView & { restaurantId: string })[] = [];
  plans: Plan[] = [
    { code: "starter", name: "Starter", monthlyPriceCents: 4900, currency: "USD", monthlyMessageLimit: 1000, monthlyAiBudgetMicros: 5_000_000, features: ["chat_widget"], active: true, createdAt: new Date(0), updatedAt: new Date(0) },
  ];

  async createAccount(a: NewAccount) {
    if (this.users.some((u) => u.email === a.user.email)) throw new EmailTakenError();
    this.users.push(a.user);
    this.restaurants.push(a.restaurant);
    this.memberships.push(a.membership);
    this.subscriptions.push(a.subscription);
  }
  async provisionRestaurant(p: NewProvision) {
    if (p.user && this.users.some((u) => u.email === p.user!.email)) throw new EmailTakenError();
    if (this.restaurants.some((r) => r.slug === p.restaurant.slug)) throw new SlugTakenError();
    if (p.user) this.users.push(p.user);
    this.restaurants.push(p.restaurant);
    this.memberships.push(p.membership);
  }
  async addMember(m: NewMember) {
    if (m.user && this.users.some((u) => u.email === m.user!.email)) throw new EmailTakenError();
    if (this.memberships.some((x) => x.userId === m.membership.userId && x.restaurantId === m.membership.restaurantId)) throw new MembershipExistsError();
    if (m.user) this.users.push(m.user);
    this.memberships.push(m.membership);
  }
  async findRestaurantBySlug(slug: string) { return this.restaurants.find((r) => r.slug === slug) ?? null; }
  async findUserByEmail(email: string) { return this.users.find((u) => u.email === email.toLowerCase()) ?? null; }
  async findUserById(userId: string) { return this.users.find((u) => u.userId === userId) ?? null; }

  async createSession(s: UserSession) { this.sessions.push(s); }
  async findSessionByTokenHash(h: string) { return this.sessions.find((s) => s.tokenHash === h) ?? null; }
  async touchSession(h: string, now: Date) { const s = this.sessions.find((x) => x.tokenHash === h); if (s) s.lastSeenAt = now; }
  async revokeSession(h: string, now: Date) { const s = this.sessions.find((x) => x.tokenHash === h && !x.revokedAt); if (s) s.revokedAt = now; }
  async revokeAllSessions(userId: string, now: Date) { for (const s of this.sessions) if (s.userId === userId && !s.revokedAt) s.revokedAt = now; }

  async listMembershipsForUser(userId: string): Promise<UserMembership[]> {
    return this.memberships
      .filter((m) => m.userId === userId && m.status === "active")
      .flatMap((membership) => {
        const r = this.restaurants.find((x) => x.restaurantId === membership.restaurantId);
        return r ? [{ membership, restaurant: { restaurantId: r.restaurantId, name: r.name, slug: r.slug, status: r.status } }] : [];
      });
  }
  async getMembership(userId: string, id: RestaurantId) {
    return this.memberships.find((m) => m.userId === userId && m.restaurantId === id && m.status === "active") ?? null;
  }

  async getRestaurant(id: RestaurantId) { return this.restaurants.find((r) => r.restaurantId === id) ?? null; }
  async updateRestaurant(id: RestaurantId, patch: RestaurantPatch, now: Date) {
    const r = this.restaurants.find((x) => x.restaurantId === id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: now });
    return r;
  }
  async updateRestaurantSettings(id: RestaurantId, patch: RestaurantSettingsPatch, now: Date) {
    const r = this.restaurants.find((x) => x.restaurantId === id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: now });
    return r;
  }
  async listTeam(id: RestaurantId): Promise<TeamMember[]> {
    return this.memberships.filter((m) => m.restaurantId === id).flatMap((m) => {
      const u = this.users.find((x) => x.userId === m.userId);
      return u ? [{ userId: u.userId, name: u.name, email: u.email, role: m.role, status: m.status }] : [];
    });
  }
  async getSubscription(id: RestaurantId) {
    const subscription = this.subscriptions.find((s) => s.restaurantId === id);
    return subscription ? { subscription, plan: await this.getPlan(subscription.planCode) } : null;
  }
  async getPlan(code: string) { return this.plans.find((p) => p.code === code) ?? null; }

  async recordAudit(id: RestaurantId, e: Parameters<AccountStore["recordAudit"]>[1], now: Date) {
    this.audit.push({ ...e, restaurantId: id, createdAt: now });
  }
  async listAudit(id: RestaurantId, opts: { limit: number; before?: Date }) {
    return this.audit
      .filter((a) => a.restaurantId === id && (!opts.before || a.createdAt < opts.before))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit)
      .map((a) => {
        const copy: Partial<typeof a> = { ...a };
        delete copy.restaurantId;
        return copy as AuditRecord;
      });
  }

  async createWidgetKey(id: RestaurantId, input: { allowedOrigins: string[]; label?: string }, now: Date) {
    const key = {
      keyId: randomBytes(12).toString("hex"), publicKey: `wk_${randomBytes(24).toString("base64url")}`,
      allowedOrigins: input.allowedOrigins, status: "active" as const, createdAt: now,
      ...(input.label !== undefined ? { label: input.label } : {}), restaurantId: id,
    };
    this.keys.push(key);
    return key;
  }
  async listWidgetKeys(id: RestaurantId) { return this.keys.filter((k) => k.restaurantId === id); }
  async revokeWidgetKey(id: RestaurantId, keyId: string, now: Date) {
    const k = this.keys.find((x) => x.restaurantId === id && x.keyId === keyId && x.status === "active");
    if (!k) return false;
    k.status = "revoked";
    k.revokedAt = now;
    return true;
  }
}
