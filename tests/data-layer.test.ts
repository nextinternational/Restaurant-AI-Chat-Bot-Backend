import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { ScopedCollection } from "../src/db/scopedCollection.js";
import { parseRestaurantId } from "../src/domain/ids.js";
import { menuItemSchema, toAllergenView, openingHoursSchema } from "../src/domain/schemas.js";
import { generateSessionToken, generateWidgetKey, hashToken, safeEqualHex } from "../src/security/tokens.js";
import { normalizeName } from "../src/repositories/normalize.js";
import { retentionPolicy } from "../src/db/retention.js";

const A = parseRestaurantId("rest_001");

/** A fake collection that records exactly what the scoped wrapper sends to MongoDB. */
function fakeCollection() {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return op === "find" ? { toArray: async () => [] } : op === "aggregate" ? { toArray: async () => [] } : Promise.resolve(null);
  };
  const col = {
    findOne: rec("findOne"), find: rec("find"), insertOne: rec("insertOne"),
    updateOne: rec("updateOne"), countDocuments: rec("countDocuments"), aggregate: rec("aggregate"),
  } as unknown as Collection<{ restaurantId: typeof A; slug?: string }>;
  return { col, calls };
}

describe("ScopedCollection (tenant isolation)", () => {
  it("always injects the tenant predicate, even when the caller filter tries to override it", () => {
    const { col, calls } = fakeCollection();
    const s = new ScopedCollection(col, A);
    void s.findOne({ slug: "x" });
    expect(calls[0]!.args[0]).toEqual({ $and: [{ restaurantId: A }, { slug: "x" }] });
    expect(() => s.findOne({ restaurantId: "rest_002" } as never)).toThrow(/restaurantId/);
  });

  it("cannot be escaped with $or / nested tricks: the tenant clause is a separate $and member", () => {
    const { col, calls } = fakeCollection();
    void new ScopedCollection(col, A).findOne({ $or: [{ slug: "a" }, { slug: "b" }] } as never);
    const f = calls[0]!.args[0] as { $and: unknown[] };
    expect(f.$and[0]).toEqual({ restaurantId: A });
  });

  it("rejects server-side JavaScript and cross-collection operators", () => {
    const s = new ScopedCollection(fakeCollection().col, A);
    expect(() => s.findOne({ $where: "sleep(1000)" } as never)).toThrow(/not allowed/);
    expect(() => s.findOne({ $expr: { $function: {} } } as never)).toThrow(/not allowed/);
    expect(() => s.aggregate([{ $lookup: { from: "menuItems" } }])).toThrow(/not allowed/);
    expect(() => s.aggregate([{ $unionWith: "menuItems" }])).toThrow(/not allowed/);
    expect(() => s.aggregate([{ $out: "x" }])).toThrow(/not allowed/);
  });

  it("refuses an insert that carries a caller-supplied restaurantId", async () => {
    const { col, calls } = fakeCollection();
    const s = new ScopedCollection(col, A);
    await expect(s.insertOne({ slug: "x", restaurantId: "rest_002" } as never)).rejects.toThrow(/restaurantId/);
    expect(calls).toHaveLength(0);
  });

  it("insert stamps the bound tenant", async () => {
    const { col, calls } = fakeCollection();
    await new ScopedCollection(col, A).insertOne({ slug: "x" });
    expect((calls.at(-1)!.args[0] as { restaurantId: string }).restaurantId).toBe("rest_001");
  });

  it("rejects updates that touch restaurantId, replacement docs and $rename", () => {
    const s = new ScopedCollection(fakeCollection().col, A);
    expect(() => s.updateOne({}, { $set: { restaurantId: "rest_002" } } as never)).toThrow(/immutable/);
    expect(() => s.updateOne({}, { slug: "x" } as never)).toThrow(/Replacement/);
    expect(() => s.updateOne({}, { $rename: { a: "b" } } as never)).toThrow(/\$rename/);
  });

  it("puts the tenant $match first in every aggregation and caps page size", async () => {
    const { col, calls } = fakeCollection();
    const s = new ScopedCollection(col, A);
    await s.aggregate([{ $match: { slug: "x" } }]);
    expect((calls[0]!.args[0] as unknown[])[0]).toEqual({ $match: { restaurantId: A } });
    await s.find({}, { limit: 10_000 });
    expect((calls[1]!.args[1] as { limit: number }).limit).toBe(100);
  });
});

describe("restaurantId", () => {
  it("accepts only well-formed ids", () => {
    expect(parseRestaurantId("rest_001")).toBe("rest_001");
    for (const bad of ["", "REST_1", "rest_", "rest_001; drop", { $ne: null }, "rest_" + "a".repeat(40), undefined]) {
      expect(() => parseRestaurantId(bad)).toThrow();
    }
  });
});

describe("tokens", () => {
  it("generates unique high-entropy tokens and stores only a hash", () => {
    const t1 = generateSessionToken();
    expect(t1).not.toBe(generateSessionToken());
    expect(t1.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(t1)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t1)).not.toContain(t1);
    expect(safeEqualHex(hashToken(t1), hashToken(t1))).toBe(true);
    expect(safeEqualHex(hashToken(t1), hashToken("other"))).toBe(false);
    expect(generateWidgetKey()).toMatch(/^wk_[A-Za-z0-9_-]{32}$/);
  });
});

const baseItem = {
  restaurantId: A, slug: "grilled-salmon", name: "Grilled Salmon", nameNormalized: "grilled salmon", category: "Mains",
  priceCents: 3800, currency: "USD", status: "active", available: true, dietaryTags: [], allergens: ["fish", "milk"],
  allergensVerified: false, createdAt: new Date(), updatedAt: new Date(),
};

describe("menu item rules", () => {
  it("prices must be non-negative integer cents", () => {
    expect(menuItemSchema.safeParse(baseItem).success).toBe(true);
    for (const priceCents of [38.5, -1, Number.NaN, 1e12]) {
      expect(menuItemSchema.safeParse({ ...baseItem, priceCents }).success).toBe(false);
    }
  });
  it("unverified allergen data is never exposed", () => {
    expect(toAllergenView({ allergens: ["fish"], allergensVerified: false })).toEqual({ verified: false });
    expect(toAllergenView({ allergens: [], allergensVerified: false })).toEqual({ verified: false }); // "empty" != "safe"
    expect(toAllergenView({ allergens: ["fish"], allergensVerified: true })).toEqual({ verified: true, allergens: ["fish"] });
  });
  it("verified allergens need an auditable who/when", () => {
    expect(menuItemSchema.safeParse({ ...baseItem, allergensVerified: true }).success).toBe(false);
    expect(
      menuItemSchema.safeParse({ ...baseItem, allergensVerified: true, allergensVerifiedAt: new Date(), allergensVerifiedBy: "chef" }).success,
    ).toBe(true);
  });
  it("rejects unknown allergens and bad slugs", () => {
    expect(menuItemSchema.safeParse({ ...baseItem, allergens: ["kryptonite"] }).success).toBe(false);
    for (const slug of ["Bad Slug", "-x", "x--y", "x_y"]) expect(menuItemSchema.safeParse({ ...baseItem, slug }).success).toBe(false);
  });
});

describe("opening hours", () => {
  const ok = { restaurantId: A, weekly: [{ day: 6, periods: [{ opens: "12:00", closes: "23:00" }] }], exceptions: [], updatedAt: new Date() };
  it("validates times and duplicates", () => {
    expect(openingHoursSchema.safeParse(ok).success).toBe(true);
    expect(openingHoursSchema.safeParse({ ...ok, weekly: [{ day: 6, periods: [{ opens: "25:00", closes: "23:00" }] }] }).success).toBe(false);
    expect(openingHoursSchema.safeParse({ ...ok, weekly: [ok.weekly[0], ok.weekly[0]] }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("normalises names for lookup", () => {
    expect(normalizeName("  Grilled   SALMON! ")).toBe("grilled salmon");
    expect(normalizeName("Crème Brûlée")).toBe("creme brulee");
  });
  it("applies per-restaurant retention overrides over platform defaults", () => {
    const defaults = { RETENTION_MESSAGES_DAYS: 30, RETENTION_CONVERSATIONS_DAYS: 90, RETENTION_USAGE_MONTHS: 13 };
    const now = new Date("2026-01-01T00:00:00Z");
    expect(retentionPolicy(defaults).messageExpiry(now).toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(retentionPolicy(defaults, { retention: { messagesDays: 7 } }).messageExpiry(now).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});


describe("SaaS foundation", () => {
  it("keeps SaaS identity concepts separate", async () => {
    const { userSchema, membershipSchema, sessionSchema, planSchema, subscriptionSchema, apiKeySchema } =
      await import("../src/domain/schemas.js");
    expect(userSchema.safeParse({
      userId: "usr_example123", email: "Owner@Example.com", name: "Owner",
      passwordHash: "scrypt$test", status: "active", createdAt: new Date(), updatedAt: new Date(),
    }).success).toBe(true);
    expect(membershipSchema.safeParse({
      userId: "usr_example123", restaurantId: A, role: "owner", status: "active",
      createdAt: new Date(), updatedAt: new Date(),
    }).success).toBe(true);
    expect(sessionSchema.safeParse({
      userId: "usr_example123", tokenHash: "a".repeat(64),
      createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(),
    }).success).toBe(true);
    expect(planSchema.safeParse({
      code: "starter", name: "Starter", monthlyPriceCents: 0, currency: "USD",
      monthlyMessageLimit: 1000, monthlyAiBudgetMicros: 1000000, features: [], active: true,
      createdAt: new Date(), updatedAt: new Date(),
    }).success).toBe(true);
    expect(subscriptionSchema.safeParse({
      restaurantId: A, planCode: "starter", status: "trialing",
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(),
      provider: "manual", createdAt: new Date(), updatedAt: new Date(),
    }).success).toBe(true);
    expect(apiKeySchema.safeParse({
      restaurantId: A, name: "Production", keyPrefix: "rk_12345678", keyHash: "b".repeat(64),
      status: "active", createdAt: new Date(),
    }).success).toBe(true);
  });
});
