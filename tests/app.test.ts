import { describe, it, expect } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const logger = pino({ level: "silent" });
const baseEnv = { NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t" };

function build(opts: { ready?: boolean; rateLimit?: number } = {}) {
  const env = loadEnv({ ...baseEnv, RATE_LIMIT_GLOBAL_PER_MIN: String(opts.rateLimit ?? 1000) });
  return createApp({
    env,
    logger,
    readinessChecks: [
      { name: "mongodb", check: async () => { if (opts.ready === false) throw new Error("db down secret-host"); } },
    ],
  });
}

describe("config", () => {
  it("fails fast on missing required variables", () => {
    expect(() => loadEnv({ NODE_ENV: "test" })).toThrow(/Invalid environment configuration/);
  });
  const prod = { ...baseEnv, NODE_ENV: "production", MONGODB_URI: "mongodb+srv://a.b.mongodb.net", TRUST_PROXY_HOPS: "1" };
  it("rejects localhost / non-TLS Mongo and wildcard CORS in production", () => {
    expect(() => loadEnv({ ...prod, MONGODB_URI: "mongodb://localhost:27017" })).toThrow(/localhost/);
    expect(() => loadEnv({ ...prod, MONGODB_URI: "mongodb://127.0.0.1:27017" })).toThrow(/localhost/);
    expect(() => loadEnv({ ...prod, MONGODB_URI: "mongodb://db.internal:27017" })).toThrow(/TLS/);
    expect(() => loadEnv({ ...prod, MONGODB_URI: "mongodb+srv://a.b.mongodb.net/?tlsInsecure=true" })).toThrow(/certificate/);
    expect(() => loadEnv({ ...prod, CORS_ALLOWED_ORIGINS: "*" })).toThrow(/wildcard/);
    expect(() => loadEnv({ ...prod, TRUST_PROXY_HOPS: "0" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadEnv(prod)).not.toThrow();
  });
  it("never echoes secret values in validation errors", () => {
    try {
      loadEnv({ ...baseEnv, MONGODB_DB_NAME: "bad name with secret-pass" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-pass");
    }
  });
});

describe("security headers", () => {
  it("sets hardened headers and hides Express", async () => {
    const res = await request(build()).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("ignores a client-supplied request id", async () => {
    const res = await request(build()).get("/health/live").set("X-Request-Id", "attacker");
    expect(res.headers["x-request-id"]).not.toBe("attacker");
  });
});

describe("health", () => {
  it("ready returns 200 when dependencies are up", async () => {
    expect((await request(build()).get("/health/ready")).status).toBe(200);
  });
  it("ready returns 503 without leaking internals when a dependency is down", async () => {
    const res = await request(build({ ready: false })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("secret-host");
  });
});

describe("request handling", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(build()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
  it("rejects oversized bodies", async () => {
    const res = await request(build()).post("/health/live").send({ a: "x".repeat(20_000) });
    expect(res.status).toBe(413);
  });
  it("rejects malformed JSON without a stack trace", async () => {
    const res = await request(build())
      .post("/health/live")
      .set("Content-Type", "application/json")
      .send("{bad json");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("SyntaxError");
  });
  it("rate limits after the threshold", async () => {
    const app = build({ rateLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).get("/nope")).status);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });
  it("never rate-limits health probes (the load balancer must not be throttled)", async () => {
    const app = build({ rateLimit: 2 });
    for (let i = 0; i < 6; i++) expect((await request(app).get("/health/live")).status).toBe(200);
  });
});

describe("cors", () => {
  it("does not allow arbitrary origins", async () => {
    const res = await request(build()).get("/health/live").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("widget script", () => {
  it("is served publicly and may be embedded cross-origin", async () => {
    const res = await request(build()).get("/widget/chat-widget.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.text).toContain("chat-widget");
  });
});
