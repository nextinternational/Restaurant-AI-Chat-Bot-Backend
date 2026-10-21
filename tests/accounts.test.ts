import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { can, PERMISSIONS, ROLES } from "../src/auth/permissions.js";
import { generatePrefixedId, hashToken } from "../src/security/tokens.js";
import { hashPasswordAsync, verifyPasswordAsync } from "../src/security/passwords.js";
import { normalizeOrigin, slugify } from "../src/domain/slug.js";
import { restaurantIdSchema } from "../src/domain/ids.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";

const logger = pino({ level: "silent" });
const PASSWORD = "correct horse battery";

function build(overrides: Record<string, string> = {}, clock?: () => Date) {
  const env = loadEnv({
    NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t",
    RATE_LIMIT_GLOBAL_PER_MIN: "10000", AUTH_RATE_LIMIT_PER_15MIN: "1000", ALLOW_PUBLIC_SIGNUP: "true", ...overrides,
  });
  const store = new MemoryAccountStore();
  const app = createApp({ env, logger, readinessChecks: [], accounts: store, ...(clock ? { clock } : {}) });
  return { app, store };
}

const signupBody = (n: number) => ({
  email: `owner${n}@example.com`, password: PASSWORD, name: `Owner ${n}`, restaurantName: `Harbor Grill ${n}`, timezone: "Asia/Dubai",
});

async function signup(app: ReturnType<typeof build>["app"], n = 1) {
  const res = await request(app).post("/v1/auth/signup").send(signupBody(n));
  expect(res.status).toBe(201);
  return { token: res.body.token as string, restaurantId: res.body.restaurants[0].restaurantId as string, body: res.body };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("ids and helpers", () => {
  it("generated tenant ids always satisfy the tenant-id validator (regression: 48% failed before)", () => {
    for (let i = 0; i < 500; i++) {
      expect(restaurantIdSchema.safeParse(generatePrefixedId("rest_")).success).toBe(true);
      expect(generatePrefixedId("usr_")).toMatch(/^usr_[a-z0-9_-]{8,40}$/);
    }
  });
  it("slugifies names, including ones with no Latin letters", () => {
    expect(slugify("Café  Olive & Co.")).toBe("cafe-olive-co");
    expect(slugify("مطعم الميناء")).toBe("");
  });
  it("accepts only bare https origins (http only for localhost outside production)", () => {
    expect(normalizeOrigin("https://Example.com", false)).toBe("https://example.com");
    for (const bad of ["https://*.example.com", "https://example.com/path", "https://example.com?x=1", "ftp://example.com",
      "http://example.com", "https://user:pw@example.com", "javascript:alert(1)", "not a url", "https://localhostx"]) {
      expect(normalizeOrigin(bad, true)).toBeNull();
    }
    expect(normalizeOrigin("http://localhost:8080", true)).toBe("http://localhost:8080");
    expect(normalizeOrigin("http://localhost:8080", false)).toBeNull();
  });
  it("async scrypt matches the sync format and rejects tampered cost parameters", async () => {
    const hash = await hashPasswordAsync(PASSWORD);
    expect(await verifyPasswordAsync(PASSWORD, hash)).toBe(true);
    expect(await verifyPasswordAsync("wrong password!!", hash)).toBe(false);
    expect(await verifyPasswordAsync(PASSWORD, hash.replace("$32768$", "$4294967296$"))).toBe(false);
  });
});

describe("permissions", () => {
  it("owner can do everything; admin cannot manage billing; viewer is read-only", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
    expect(can("admin", "billing:manage")).toBe(false);
    expect(can("admin", "team:manage")).toBe(true);
    for (const p of PERMISSIONS.filter((x) => x.endsWith(":write") || x.endsWith(":manage"))) expect(can("viewer", p)).toBe(false);
    expect(can("staff", "widgets:manage")).toBe(false);
    expect(ROLES).toHaveLength(5);
  });
});

describe("signup / login / sessions", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it("signup creates user, tenant, owner membership, trial subscription and audit entry", async () => {
    const { body, restaurantId } = await signup(ctx.app);
    expect(body.restaurants[0]).toMatchObject({ role: "owner", name: "Harbor Grill 1" });
    expect(body.restaurants[0].slug).toMatch(/^harbor-grill-1-[0-9a-f]{8}$/);
    expect(ctx.store.subscriptions[0]).toMatchObject({ restaurantId, planCode: "starter", status: "trialing", provider: "manual" });
    expect(ctx.store.restaurants[0]?.monthlyAiBudgetMicros).toBe(5_000_000);
    expect(ctx.store.audit[0]).toMatchObject({ action: "restaurant.created", restaurantId });
  });

  it("never stores the password or the raw session token", async () => {
    const { token } = await signup(ctx.app);
    const stored = JSON.stringify([ctx.store.users, ctx.store.sessions]);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(token);
    expect(ctx.store.sessions[0]?.tokenHash).toBe(hashToken(token));
    expect(ctx.store.users[0]?.passwordHash.startsWith("scrypt$")).toBe(true);
  });

  it("marks auth responses no-store and never returns the password hash", async () => {
    const res = await request(ctx.app).post("/v1/auth/signup").send(signupBody(1));
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain("scrypt");
  });

  it("rejects duplicate emails (case-insensitive) and weak / malformed input", async () => {
    await signup(ctx.app);
    const dup = await request(ctx.app).post("/v1/auth/signup").send({ ...signupBody(2), email: "OWNER1@example.com" });
    expect(dup.status).toBe(409);
    const cases = [
      { ...signupBody(3), password: "short" },
      { ...signupBody(3), email: "not-an-email" },
      { ...signupBody(3), timezone: "Mars/Olympus" },
      { ...signupBody(3), currency: "dollars" },
      { ...signupBody(3), role: "owner" },
      { ...signupBody(3), password: "owner3@example.com" },
      { ...signupBody(3), email: { $ne: null } },
    ];
    for (const c of cases) expect((await request(ctx.app).post("/v1/auth/signup").send(c)).status).toBe(400);
  });

  it("login works, and wrong password / unknown email give the identical 401", async () => {
    await signup(ctx.app);
    const ok = await request(ctx.app).post("/v1/auth/login").send({ email: "Owner1@Example.com", password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.restaurants).toHaveLength(1);
    const wrong = await request(ctx.app).post("/v1/auth/login").send({ email: "owner1@example.com", password: "wrong password!!" });
    const unknown = await request(ctx.app).post("/v1/auth/login").send({ email: "nobody@example.com", password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("a suspended user cannot log in and an existing session dies immediately", async () => {
    const { token } = await signup(ctx.app);
    ctx.store.users[0]!.status = "suspended";
    expect((await request(ctx.app).get("/v1/me").set(bearer(token))).status).toBe(401);
    const login = await request(ctx.app).post("/v1/auth/login").send({ email: "owner1@example.com", password: PASSWORD });
    expect(login.status).toBe(403);
  });

  it("requires a valid bearer token; rejects garbage, query-string tokens and revoked sessions", async () => {
    const { token } = await signup(ctx.app);
    expect((await request(ctx.app).get("/v1/me")).status).toBe(401);
    expect((await request(ctx.app).get("/v1/me").set(bearer("x".repeat(43)))).status).toBe(401);
    expect((await request(ctx.app).get(`/v1/me?token=${token}`)).status).toBe(401);
    expect((await request(ctx.app).get("/v1/me").set(bearer(token))).status).toBe(200);
    expect((await request(ctx.app).post("/v1/auth/logout").set(bearer(token))).status).toBe(204);
    expect((await request(ctx.app).get("/v1/me").set(bearer(token))).status).toBe(401);
  });

  it("logout-all revokes every session of the user", async () => {
    const { token } = await signup(ctx.app);
    const second = (await request(ctx.app).post("/v1/auth/login").send({ email: "owner1@example.com", password: PASSWORD })).body.token as string;
    expect((await request(ctx.app).post("/v1/auth/logout-all").set(bearer(token))).status).toBe(204);
    expect((await request(ctx.app).get("/v1/me").set(bearer(second))).status).toBe(401);
  });

  it("expires sessions after SESSION_TTL_HOURS", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const c = build({ SESSION_TTL_HOURS: "1" }, () => now);
    const { token } = await signup(c.app);
    expect((await request(c.app).get("/v1/me").set(bearer(token))).status).toBe(200);
    now = new Date("2026-01-01T01:00:01Z");
    expect((await request(c.app).get("/v1/me").set(bearer(token))).status).toBe(401);
  });

  it("throttles password guessing per account, even across rotating IPs", async () => {
    const c = build({ LOGIN_RATE_LIMIT_PER_EMAIL_15MIN: "3" });
    await signup(c.app);
    const attempt = () => request(c.app).post("/v1/auth/login").send({ email: "owner1@example.com", password: "wrong password!!" });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    // even the correct password is blocked while the limit holds
    expect((await request(c.app).post("/v1/auth/login").send({ email: "owner1@example.com", password: PASSWORD })).status).toBe(429);
  });
});

describe("tenant admin API", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it("owner reads and updates their restaurant; protected fields cannot be set", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const base = `/v1/restaurants/${restaurantId}`;
    expect((await request(ctx.app).get(base).set(bearer(token))).body).toMatchObject({ restaurantId, role: "owner", timezone: "Asia/Dubai" });
    const patched = await request(ctx.app).patch(base).set(bearer(token)).send({ name: "New Name", defaultLocale: "ar" });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("New Name");
    for (const evil of [{ status: "suspended" }, { restaurantId: "rest_other" }, { monthlyAiBudgetMicros: 999999999 }, {}]) {
      expect((await request(ctx.app).patch(base).set(bearer(token)).send(evil)).status).toBe(400);
    }
    expect(ctx.store.restaurants[0]?.monthlyAiBudgetMicros).toBe(5_000_000);
    const audit = await request(ctx.app).get(`${base}/audit-logs`).set(bearer(token));
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["restaurant.created", "restaurant.updated"]));
  });

  it("CROSS-TENANT: user A can never read or change tenant B, and B's id looks like any unknown id", async () => {
    const a = await signup(ctx.app, 1);
    const b = await signup(ctx.app, 2);
    const paths = [["get", ""], ["patch", ""], ["get", "/team"], ["get", "/subscription"], ["get", "/audit-logs"], ["get", "/widget-keys"], ["post", "/widget-keys"]] as const;
    for (const [method, suffix] of paths) {
      // eslint-disable-next-line security/detect-object-injection -- `method` comes from the fixed literal table above
      const res = await request(ctx.app)[method](`/v1/restaurants/${b.restaurantId}${suffix}`).set(bearer(a.token))
        .send(method === "get" ? undefined : { name: "hacked", allowedOrigins: ["https://evil.example"] });
      expect(res.status, `${method} ${suffix}`).toBe(404);
    }
    const unknown = await request(ctx.app).get("/v1/restaurants/rest_00000000000000000000000000000000").set(bearer(a.token));
    expect(unknown.status).toBe(404);
    expect(ctx.store.restaurants.find((r) => r.restaurantId === b.restaurantId)?.name).toBe("Harbor Grill 2");
    expect(ctx.store.keys).toHaveLength(0);
    // malformed / injection-shaped ids are plain 404s too
    for (const id of ["rest_%24ne", "..%2F..", "REST_1", "x".repeat(200)]) {
      expect((await request(ctx.app).get(`/v1/restaurants/${id}`).set(bearer(a.token))).status).toBe(404);
    }
  });

  it("enforces roles: viewer reads but cannot write, staff cannot see billing/audit, admin cannot be owner-only", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const base = `/v1/restaurants/${restaurantId}`;
    const addMember = async (n: number, role: "viewer" | "staff" | "admin") => {
      const email = `member${n}@example.com`;
      await request(ctx.app).post("/v1/auth/signup").send({ ...signupBody(100 + n), email });
      // move this user's membership into the first tenant with the desired role (test setup only)
      const user = ctx.store.users.find((u) => u.email === email)!;
      ctx.store.memberships = ctx.store.memberships.filter((m) => m.userId !== user.userId);
      ctx.store.memberships.push({ userId: user.userId, restaurantId: restaurantId as never, role, status: "active", createdAt: new Date(), updatedAt: new Date() });
      return (await request(ctx.app).post("/v1/auth/login").send({ email, password: PASSWORD })).body.token as string;
    };
    const viewer = await addMember(1, "viewer");
    const staff = await addMember(2, "staff");
    const admin = await addMember(3, "admin");

    expect((await request(ctx.app).get(base).set(bearer(viewer))).status).toBe(200);
    expect((await request(ctx.app).patch(base).set(bearer(viewer)).send({ name: "x" })).status).toBe(403);
    expect((await request(ctx.app).get(`${base}/subscription`).set(bearer(staff))).status).toBe(403);
    expect((await request(ctx.app).get(`${base}/audit-logs`).set(bearer(staff))).status).toBe(403);
    expect((await request(ctx.app).post(`${base}/widget-keys`).set(bearer(staff)).send({ allowedOrigins: ["https://a.example.com"] })).status).toBe(403);
    expect((await request(ctx.app).post(`${base}/widget-keys`).set(bearer(admin)).send({ allowedOrigins: ["https://a.example.com"] })).status).toBe(201);
    expect((await request(ctx.app).get(`${base}/team`).set(bearer(token))).body.members).toHaveLength(4);
  });

  it("team listing never exposes password hashes", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const res = await request(ctx.app).get(`/v1/restaurants/${restaurantId}/team`).set(bearer(token));
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|passwordHash/);
    expect(res.body.members[0]).toMatchObject({ email: "owner1@example.com", role: "owner" });
  });

  it("subscription endpoint shows trial status and plan limits", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const res = await request(ctx.app).get(`/v1/restaurants/${restaurantId}/subscription`).set(bearer(token));
    expect(res.body).toMatchObject({ status: "trialing", planCode: "starter", plan: { monthlyMessageLimit: 1000 } });
  });

  it("widget keys: create with validated origins, list, revoke, audit; wildcard/path origins rejected", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const base = `/v1/restaurants/${restaurantId}/widget-keys`;
    for (const bad of [["https://*.example.com"], ["https://example.com/x"], ["http://example.com"], []]) {
      expect((await request(ctx.app).post(base).set(bearer(token)).send({ allowedOrigins: bad })).status).toBe(400);
    }
    const created = await request(ctx.app).post(base).set(bearer(token)).send({ allowedOrigins: ["https://Example.com", "https://example.com"], label: "main site" });
    expect(created.status).toBe(201);
    expect(created.body.allowedOrigins).toEqual(["https://example.com"]);
    expect(created.body.publicKey).toMatch(/^wk_/);
    expect((await request(ctx.app).get(base).set(bearer(token))).body.keys).toHaveLength(1);
    expect((await request(ctx.app).delete(`${base}/${created.body.keyId}`).set(bearer(token))).status).toBe(204);
    expect((await request(ctx.app).delete(`${base}/${created.body.keyId}`).set(bearer(token))).status).toBe(404);
    expect((await request(ctx.app).delete(`${base}/not-a-key`).set(bearer(token))).status).toBe(404);
    const actions = ctx.store.audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["widget_key.created", "widget_key.revoked"]));
  });

  it("caps active widget keys per restaurant", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    const base = `/v1/restaurants/${restaurantId}/widget-keys`;
    for (let i = 0; i < 10; i++) {
      expect((await request(ctx.app).post(base).set(bearer(token)).send({ allowedOrigins: ["https://a.example.com"] })).status).toBe(201);
    }
    expect((await request(ctx.app).post(base).set(bearer(token)).send({ allowedOrigins: ["https://a.example.com"] })).status).toBe(409);
  });

  it("a suspended restaurant is blocked for its members", async () => {
    const { token, restaurantId } = await signup(ctx.app);
    ctx.store.restaurants[0]!.status = "suspended";
    expect((await request(ctx.app).get(`/v1/restaurants/${restaurantId}`).set(bearer(token))).status).toBe(403);
  });
});
