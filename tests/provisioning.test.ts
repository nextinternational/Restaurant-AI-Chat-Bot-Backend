import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { ProvisioningService } from "../src/services/provisioningService.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";

const logger = pino({ level: "silent" });
const PASSWORD = "correct horse battery";
const base = { name: "Harbor Grill", timezone: "Asia/Dubai", ownerEmail: "Owner@Example.com", ownerName: "Sam" };

function setup() {
  const env = loadEnv({ NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000", AUTH_RATE_LIMIT_PER_15MIN: "1000" });
  const store = new MemoryAccountStore();
  const service = new ProvisioningService(store, { allowInsecureLocalhostOrigins: false }, logger);
  const app = createApp({ env, logger, readinessChecks: [], accounts: store });
  return { store, service, app };
}

describe("internal provisioning", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("creates restaurant + owner without any subscription, and the owner can log in", async () => {
    const r = await ctx.service.provisionRestaurant({ ...base, ownerPassword: PASSWORD, origins: ["https://harborgrill.com"] });
    expect(r.slug).toBe("harbor-grill");
    expect(r.owner).toMatchObject({ email: "owner@example.com", created: true });
    expect(r.owner.generatedPassword).toBeUndefined();
    expect(ctx.store.subscriptions).toHaveLength(0);
    expect(ctx.store.memberships[0]).toMatchObject({ role: "owner", status: "active" });
    expect(r.widgetKeys[0]?.allowedOrigins).toEqual(["https://harborgrill.com"]);
    expect(ctx.store.audit[0]?.action).toBe("restaurant.provisioned");

    const login = await request(ctx.app).post("/v1/auth/login").send({ email: "owner@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.restaurants[0]).toMatchObject({ slug: "harbor-grill", role: "owner" });
  });

  it("generates a strong password when none is given, shows it once, and stores only a hash", async () => {
    const r = await ctx.service.provisionRestaurant(base);
    const pw = r.owner.generatedPassword!;
    expect(pw.length).toBeGreaterThanOrEqual(24);
    expect(ctx.store.users[0]?.passwordHash).not.toContain(pw);
    const login = await request(ctx.app).post("/v1/auth/login").send({ email: "owner@example.com", password: pw });
    expect(login.status).toBe(200);
  });

  it("attaches an existing user to a second restaurant without touching their password", async () => {
    await ctx.service.provisionRestaurant({ ...base, ownerPassword: PASSWORD });
    const second = await ctx.service.provisionRestaurant({ ...base, name: "Olive Demo", ownerPassword: "a-completely-different-pw" });
    expect(second.owner.created).toBe(false);
    expect(ctx.store.users).toHaveLength(1);
    const login = await request(ctx.app).post("/v1/auth/login").send({ email: "owner@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.restaurants).toHaveLength(2);
  });

  it("rejects duplicate slugs and leaves no half-created owner behind", async () => {
    await ctx.service.provisionRestaurant({ ...base, ownerPassword: PASSWORD });
    await expect(ctx.service.provisionRestaurant({ ...base, ownerEmail: "other@example.com", ownerPassword: PASSWORD }))
      .rejects.toMatchObject({ code: "slug_taken" });
    expect(ctx.store.users.map((u) => u.email)).toEqual(["owner@example.com"]);
  });

  it("validates input: non-Latin name needs --slug, bad origin, short password, bad timezone", async () => {
    await expect(ctx.service.provisionRestaurant({ ...base, name: "مطعم الميناء" })).rejects.toMatchObject({ code: "validation_error" });
    expect(await ctx.service.provisionRestaurant({ ...base, name: "مطعم الميناء", slug: "mina-restaurant" })).toMatchObject({ slug: "mina-restaurant" });
    await expect(ctx.service.provisionRestaurant({ ...base, name: "X Cafe", origins: ["https://*.x.com"] })).rejects.toMatchObject({ code: "invalid_origin" });
    await expect(ctx.service.provisionRestaurant({ ...base, name: "Y Cafe", ownerPassword: "short" })).rejects.toMatchObject({ code: "validation_error" });
    await expect(ctx.service.provisionRestaurant({ ...base, name: "Z Cafe", timezone: "Mars/Base" })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("adds staff with a role, blocks duplicates, and role limits still apply", async () => {
    await ctx.service.provisionRestaurant({ ...base, ownerPassword: PASSWORD });
    const s = await ctx.service.addStaff({ restaurantSlug: "harbor-grill", email: "chef@example.com", name: "Chef", role: "viewer", password: PASSWORD });
    expect(s.role).toBe("viewer");
    await expect(ctx.service.addStaff({ restaurantSlug: "harbor-grill", email: "chef@example.com", name: "Chef" })).rejects.toMatchObject({ code: "already_member" });
    await expect(ctx.service.addStaff({ restaurantSlug: "nope", email: "a@example.com", name: "A" })).rejects.toMatchObject({ code: "not_found" });

    const login = await request(ctx.app).post("/v1/auth/login").send({ email: "chef@example.com", password: PASSWORD });
    const id = login.body.restaurants[0].restaurantId as string;
    const auth = { Authorization: `Bearer ${login.body.token as string}` };
    expect((await request(ctx.app).get(`/v1/restaurants/${id}`).set(auth)).status).toBe(200);
    expect((await request(ctx.app).patch(`/v1/restaurants/${id}`).set(auth).send({ name: "Hacked" })).status).toBe(403);
  });
});
