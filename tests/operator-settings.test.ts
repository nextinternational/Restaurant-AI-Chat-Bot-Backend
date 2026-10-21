import { describe, it, expect } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { ProvisioningService } from "../src/services/provisioningService.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";

const logger = pino({ level: "silent" });
const PASSWORD = "correct horse battery";

describe("self-service signup", () => {
  it("is not exposed unless explicitly enabled", async () => {
    const env = loadEnv({ NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t" });
    const app = createApp({ env, logger, readinessChecks: [], accounts: new MemoryAccountStore() });
    const res = await request(app).post("/v1/auth/signup").send({ email: "x@example.com", password: PASSWORD, name: "X", restaurantName: "Y", timezone: "UTC" });
    expect(res.status).toBe(404);
  });
});

describe("no staff conversation endpoints", () => {
  it("does not expose conversation listing, reading or closing", async () => {
    const env = loadEnv({ NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", ALLOW_PUBLIC_SIGNUP: "true", RATE_LIMIT_GLOBAL_PER_MIN: "10000", AUTH_RATE_LIMIT_PER_15MIN: "1000" });
    const app = createApp({ env, logger, readinessChecks: [], accounts: new MemoryAccountStore() });
    const signup = await request(app).post("/v1/auth/signup").send({ email: "o@example.com", password: PASSWORD, name: "Owner", restaurantName: "Place", timezone: "Asia/Dubai" });
    const id = signup.body.restaurants[0].restaurantId as string;
    const auth = { Authorization: `Bearer ${signup.body.token}` };
    expect((await request(app).get(`/v1/restaurants/${id}/conversations`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/v1/restaurants/${id}/conversations/abc`).set(auth)).status).toBe(404);
    expect((await request(app).post(`/v1/restaurants/${id}/conversations/abc/close`).set(auth)).status).toBe(404);
  });
});

describe("operator settings (CLI service)", () => {
  function prov() {
    const store = new MemoryAccountStore();
    const service = new ProvisioningService(store, { allowInsecureLocalhostOrigins: false }, logger);
    return { store, service };
  }
  const base = { name: "Harbor Grill", timezone: "America/Antigua", ownerEmail: "owner@example.com", ownerName: "Sam", ownerPassword: PASSWORD };

  it("sets address, contact phone number and AI budget, merging with what exists, and audits it", async () => {
    const { store, service } = prov();
    await service.provisionRestaurant(base);
    await service.updateSettings({ restaurantSlug: "harbor-grill", address: "1 Beach Road", phone: "+1 268 555 0100", monthlyAiBudgetUsd: 25 });
    await service.updateSettings({ restaurantSlug: "harbor-grill", notes: "Free parking" });
    const r = store.restaurants[0]!;
    expect(r.location).toEqual({ address: "1 Beach Road", phone: "+1 268 555 0100", notes: "Free parking" });
    expect(r).not.toHaveProperty("notifications");
    expect(r.monthlyAiBudgetMicros).toBe(25_000_000);
    expect(store.audit.filter((a) => a.action === "restaurant.settings_updated")).toHaveLength(2);
  });

  it("rejects bad input and unknown restaurants", async () => {
    const { service } = prov();
    await service.provisionRestaurant(base);
    await expect(service.updateSettings({ restaurantSlug: "harbor-grill", phone: "123" })).rejects.toThrow(/address/);
    await expect(service.updateSettings({ restaurantSlug: "harbor-grill" })).rejects.toThrow(/nothing to update/);
    await expect(service.updateSettings({ restaurantSlug: "harbor-grill", telegramChatId: "42" } as never)).rejects.toThrow();
    await expect(service.updateSettings({ restaurantSlug: "nope", address: "x" })).rejects.toThrow(/No restaurant/);
  });
});

describe("config", () => {
  it("parses the signup flag strictly", () => {
    const base = { NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t" };
    expect(() => loadEnv({ ...base, ALLOW_PUBLIC_SIGNUP: "yes" })).toThrow(/ALLOW_PUBLIC_SIGNUP/);
    expect(loadEnv({ ...base, ALLOW_PUBLIC_SIGNUP: "true" }).ALLOW_PUBLIC_SIGNUP).toBe(true);
  });

  it("treats empty optional values (KEY= in .env / compose) as unset instead of refusing to boot", () => {
    const base = { NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t" };
    expect(loadEnv({ ...base, OPENAI_API_KEY: "" }).OPENAI_API_KEY).toBeUndefined();
  });

  it("no longer knows notification settings", () => {
    const base = { NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t" };
    const env = loadEnv({ ...base, TELEGRAM_BOT_TOKEN: "x", SMTP_URL: "smtp://x" });
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(env).not.toHaveProperty("SMTP_URL");
  });
});
