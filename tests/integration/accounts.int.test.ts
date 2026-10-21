/**
 * Runs against a REAL MongoDB (CI service container). Skipped when MONGODB_TEST_URI is not set.
 * Covers what the in-memory double cannot: validators, unique indexes and ScopedCollection behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import pino from "pino";
import request from "supertest";
import { runMigrations } from "../../src/db/migrate.js";
import { createRepositories, type Repositories } from "../../src/repositories/index.js";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";

const uri = process.env.MONGODB_TEST_URI;
const retention = { RETENTION_MESSAGES_DAYS: 30, RETENTION_CONVERSATIONS_DAYS: 90, RETENTION_USAGE_MONTHS: 13 };
const PASSWORD = "correct horse battery";

describe.skipIf(!uri)("accounts against MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let repos: Repositories;
  let app: ReturnType<typeof createApp>;

  const body = (n: number) => ({
    email: `it${n}@example.com`, password: PASSWORD, name: `Owner ${n}`, restaurantName: `Place ${n}`, timezone: "Asia/Dubai",
  });

  beforeAll(async () => {
    client = new MongoClient(uri!);
    await client.connect();
    db = client.db(`it_acc_${Date.now()}`);
    await runMigrations(db);
    repos = createRepositories(db, retention);
    const env = loadEnv({
      NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t",
      RATE_LIMIT_GLOBAL_PER_MIN: "10000", AUTH_RATE_LIMIT_PER_15MIN: "1000", ALLOW_PUBLIC_SIGNUP: "true",
    });
    app = createApp({ env, logger: pino({ level: "silent" }), readinessChecks: [], accounts: repos.accounts });
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it("migration 003 seeds the default plans and accepts int32 AI budgets", async () => {
    const plan = await repos.accounts.getPlan("starter");
    expect(plan?.monthlyAiBudgetMicros).toBeGreaterThan(0);
  });

  it("full flow: signup -> me -> update -> widget key, with documents that satisfy the DB validators", async () => {
    const signup = await request(app).post("/v1/auth/signup").send(body(1));
    expect(signup.status).toBe(201);
    const { token } = signup.body as { token: string };
    const restaurantId = signup.body.restaurants[0].restaurantId as string;
    const auth = { Authorization: `Bearer ${token}` };

    expect((await request(app).get("/v1/me").set(auth)).body.user.email).toBe("it1@example.com");
    expect((await request(app).patch(`/v1/restaurants/${restaurantId}`).set(auth).send({ name: "Renamed" })).status).toBe(200);
    const key = await request(app).post(`/v1/restaurants/${restaurantId}/widget-keys`).set(auth).send({ allowedOrigins: ["https://example.com"] });
    expect(key.status).toBe(201);
    expect((await request(app).delete(`/v1/restaurants/${restaurantId}/widget-keys/${key.body.keyId}`).set(auth)).status).toBe(204);
    const audit = (await request(app).get(`/v1/restaurants/${restaurantId}/audit-logs`).set(auth)).body.entries as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["restaurant.created", "restaurant.updated", "widget_key.created", "widget_key.revoked"]));
  });

  it("duplicate email -> 409 and leaves no orphan tenant", async () => {
    await request(app).post("/v1/auth/signup").send(body(2));
    const before = await repos.cols.restaurants.countDocuments();
    const dup = await request(app).post("/v1/auth/signup").send(body(2));
    expect(dup.status).toBe(409);
    expect(await repos.cols.restaurants.countDocuments()).toBe(before);
  });

  it("tenant B is invisible to tenant A at the database layer", async () => {
    const a = await request(app).post("/v1/auth/signup").send(body(3));
    const b = await request(app).post("/v1/auth/signup").send(body(4));
    const bId = b.body.restaurants[0].restaurantId as string;
    const res = await request(app).get(`/v1/restaurants/${bId}/team`).set({ Authorization: `Bearer ${a.body.token}` });
    expect(res.status).toBe(404);
  });

  it("stores only the token hash, and sessions carry a TTL-indexed expiresAt", async () => {
    const s = await request(app).post("/v1/auth/signup").send(body(5));
    const raw = JSON.stringify(await repos.cols.sessions.find({}).toArray());
    expect(raw).not.toContain(s.body.token);
    const indexes = await repos.cols.sessions.indexes();
    expect(indexes.some((i) => i.expireAfterSeconds === 0)).toBe(true);
  });
});
