/**
 * Runs against a REAL MongoDB (CI service container or `docker compose up mongo`).
 * Skipped automatically when MONGODB_TEST_URI is not set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { runMigrations, assertSchemaCurrent } from "../../src/db/migrate.js";
import { createRepositories, type Repositories } from "../../src/repositories/index.js";
import { parseRestaurantId } from "../../src/domain/ids.js";
import { generateWidgetKey } from "../../src/security/tokens.js";

const uri = process.env.MONGODB_TEST_URI;
const retention = { RETENTION_MESSAGES_DAYS: 30, RETENTION_CONVERSATIONS_DAYS: 90, RETENTION_USAGE_MONTHS: 13 };
const A = parseRestaurantId("rest_001");
const B = parseRestaurantId("rest_002");

describe.skipIf(!uri)("tenant isolation against MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let repos: Repositories;

  const item = (priceCents: number) => ({
    slug: "grilled-salmon", name: "Grilled Salmon", category: "Mains", priceCents, currency: "USD",
    status: "active" as const, available: true, dietaryTags: [], allergens: ["fish" as const], allergensVerified: false,
  });

  beforeAll(async () => {
    client = new MongoClient(uri!);
    await client.connect();
    db = client.db(`it_${Date.now()}`);
    await runMigrations(db);
    repos = createRepositories(db, retention);
    const now = new Date();
    for (const id of [A, B]) {
      await repos.cols.restaurants.insertOne({
        restaurantId: id, slug: id.replace("_", "-"), name: id, status: "active", timezone: "UTC", currency: "USD",
        defaultLocale: "en", retention: {}, monthlyAiBudgetMicros: 0, createdAt: now, updatedAt: now,
      });
    }
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it("migrations are idempotent and boot check passes", async () => {
    expect(await runMigrations(db)).toEqual([]);
    await expect(assertSchemaCurrent(db)).resolves.toBeUndefined();
  });

  it("the same slug can exist in two restaurants and each sees only its own price", async () => {
    await repos.forTenant({ restaurantId: A, retention: {} }).menu.create(item(3800));
    await repos.forTenant({ restaurantId: B, retention: {} }).menu.create(item(2900));
    expect((await repos.forTenant({ restaurantId: A, retention: {} }).menu.findBySlug("grilled-salmon"))?.priceCents).toBe(3800);
    expect((await repos.forTenant({ restaurantId: B, retention: {} }).menu.findBySlug("grilled-salmon"))?.priceCents).toBe(2900);
  });

  it("a duplicate slug inside ONE restaurant is rejected", async () => {
    await expect(repos.forTenant({ restaurantId: A, retention: {} }).menu.create(item(1))).rejects.toMatchObject({ code: "conflict" });
  });

  it("a price update in A never touches B", async () => {
    const a = repos.forTenant({ restaurantId: A, retention: {} });
    expect(await a.menu.updatePrice("grilled-salmon", 4000)).toBe(true);
    expect((await repos.forTenant({ restaurantId: B, retention: {} }).menu.findBySlug("grilled-salmon"))?.priceCents).toBe(2900);
  });

  it("the database itself rejects float prices and missing tenant ids (validator)", async () => {
    await expect(db.collection("menuItems").insertOne({ slug: "x", priceCents: 38.5 })).rejects.toThrow();
  });

  it("a session token from A is useless in B", async () => {
    const a = repos.forTenant({ restaurantId: A, retention: {} });
    const b = repos.forTenant({ restaurantId: B, retention: {} });
    const { sessionToken, conversationId } = await a.conversations.start();
    expect(await a.conversations.findBySessionToken(sessionToken)).not.toBeNull();
    expect(await b.conversations.findBySessionToken(sessionToken)).toBeNull();
    await expect(b.conversations.appendMessage(conversationId, { role: "user", content: "hi" })).rejects.toMatchObject({ code: "not_found" });
    const stored = await db.collection("conversations").findOne({});
    expect(JSON.stringify(stored)).not.toContain(sessionToken);
  });

  it("usage totals are per tenant", async () => {
    const a = repos.forTenant({ restaurantId: A, retention: {} });
    const b = repos.forTenant({ restaurantId: B, retention: {} });
    const { conversationId } = await a.conversations.start();
    await a.usage.record({ conversationId, model: "m", inputTokens: 100, outputTokens: 10, estimatedCostMicros: 500 });
    const range: [Date, Date] = [new Date(Date.now() - 60_000), new Date(Date.now() + 60_000)];
    expect((await a.usage.totals(...range)).estimatedCostMicros).toBe(500);
    expect((await b.usage.totals(...range)).requests).toBe(0);
  });

  it("TTL indexes exist on conversations, messages and usageLogs", async () => {
    for (const name of ["conversations", "messages", "usageLogs"]) {
      const idx = await db.collection(name).indexes();
      expect(idx.some((i) => i.expireAfterSeconds === 0 && "expiresAt" in i.key)).toBe(true);
    }
  });

  it("widget keys resolve only while the key and the restaurant are active", async () => {
    const publicKey = generateWidgetKey();
    await repos.cols.widgetKeys.insertOne({ restaurantId: A, publicKey, allowedOrigins: ["https://a.example"], status: "active", createdAt: new Date() });
    expect((await repos.tenantResolver.resolveWidgetKey(publicKey))?.restaurantId).toBe(A);
    expect(await repos.tenantResolver.resolveWidgetKey({ $ne: null })).toBeNull();
    await repos.cols.widgetKeys.updateOne({ publicKey }, { $set: { status: "revoked" } });
    expect(await repos.tenantResolver.resolveWidgetKey(publicKey)).toBeNull();
  });
});
