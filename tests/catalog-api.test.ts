import { describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { CatalogAdminService } from "../src/services/catalog/catalogAdminService.js";
import { ProvisioningService } from "../src/services/provisioningService.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";
import { MemoryCatalogGateway } from "./helpers/memoryCatalog.js";
import { NOW } from "./helpers/memoryChat.js";

const logger = pino({ level: "silent" });
const PASSWORD = "correct horse battery";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function setup(extra: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000",
    AUTH_RATE_LIMIT_PER_15MIN: "1000", ALLOW_PUBLIC_SIGNUP: "true", ...extra,
  });
  const store = new MemoryAccountStore();
  const gateway = new MemoryCatalogGateway();
  const app = createApp({ env, logger, readinessChecks: [], accounts: store, catalog: new CatalogAdminService(gateway, store, () => NOW) });
  const prov = new ProvisioningService(store, { allowInsecureLocalhostOrigins: false }, logger);

  const signup = async (n: number) => {
    const r = await request(app).post("/v1/auth/signup").send({ email: `o${n}@example.com`, password: PASSWORD, name: `Owner ${n}`, restaurantName: `Place ${n}`, timezone: "Asia/Dubai" });
    expect(r.status).toBe(201);
    return { token: r.body.token as string, id: r.body.restaurants[0].restaurantId as string, slug: store.restaurants.find((x) => x.restaurantId === r.body.restaurants[0].restaurantId)!.slug };
  };
  const withRole = async (slug: string, role: "manager" | "staff" | "viewer") => {
    const email = `${role}@example.com`;
    await prov.addStaff({ restaurantSlug: slug, email, name: `The ${role}`, role, password: PASSWORD });
    const r = await request(app).post("/v1/auth/login").send({ email, password: PASSWORD });
    return r.body.token as string;
  };
  const a = await signup(1);
  const b = await signup(2);
  return { app, store, gateway, a, b, withRole };
}

const salmon = { name: "Grilled Salmon", category: "Mains", priceCents: 3800 };
const base = (id: string) => `/v1/restaurants/${id}`;

describe("menu management API", () => {
  it("creates, reads, lists and updates items; the currency comes from the restaurant, never the client", async () => {
    const { app, a } = await setup();
    const created = await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ ...salmon, description: "Fresh", dietaryTags: ["halal", "halal"] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "grilled-salmon", priceCents: 3800, currency: "XCD", status: "active", available: true, dietaryTags: ["halal"] });
    expect(created.body.allergens).toMatchObject({ declared: [], verified: false });
    expect(JSON.stringify(created.body)).not.toContain("restaurantId");

    expect((await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ ...salmon, currency: "USD" })).status).toBe(400); // strict body
    expect((await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ ...salmon, name: "Other", priceCents: 38.5 })).status).toBe(400); // no floats
    expect((await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ ...salmon, restaurantId: "rest_999" })).status).toBe(400);

    const patch = await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token)).send({ priceCents: 4200, description: null });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ priceCents: 4200, description: null });
    expect((await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token)).send({})).status).toBe(400);

    const list = await request(app).get(`${base(a.id)}/menu/items`).set(auth(a.token));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeNull();
    expect((await request(app).get(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token))).status).toBe(200);
    expect((await request(app).get(`${base(a.id)}/menu/items/Not_A_Slug!`).set(auth(a.token))).status).toBe(404);
  });

  it("derives slugs, refuses duplicates and requires an explicit slug for non-Latin names", async () => {
    const { app, a } = await setup();
    const post = (body: object) => request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(body);
    expect((await post(salmon)).status).toBe(201);
    expect((await post({ ...salmon, name: "grilled  SALMON!" })).body.error.code).toBe("duplicate_name");
    expect((await post({ ...salmon, name: "Salmon 2", slug: "grilled-salmon" })).status).toBe(409);
    const arabic = await post({ name: "سلمون مشوي", category: "Mains", priceCents: 100 });
    expect(arabic.status).toBe(400);
    expect(arabic.body.error.code).toBe("slug_required");
    expect((await post({ name: "سلمون مشوي", slug: "salmon-ar", category: "Mains", priceCents: 100 })).status).toBe(201);
    // renaming onto an existing name is refused
    expect((await request(app).patch(`${base(a.id)}/menu/items/salmon-ar`).set(auth(a.token)).send({ name: "Grilled Salmon" })).status).toBe(409);
  });

  it("paginates with a slug cursor", async () => {
    const { app, a } = await setup();
    for (const n of ["Apple", "Banana", "Cherry"]) await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ name: n, category: "Desserts", priceCents: 500 });
    const p1 = await request(app).get(`${base(a.id)}/menu/items?limit=2`).set(auth(a.token));
    expect(p1.body.items.map((i: { slug: string }) => i.slug)).toEqual(["apple", "banana"]);
    expect(p1.body.nextCursor).toBe("banana");
    const p2 = await request(app).get(`${base(a.id)}/menu/items?limit=2&after=${p1.body.nextCursor}`).set(auth(a.token));
    expect(p2.body.items.map((i: { slug: string }) => i.slug)).toEqual(["cherry"]);
    expect(p2.body.nextCursor).toBeNull();
  });

  it("archives (idempotent) and restores, and refuses to restore onto a name now in use", async () => {
    const { app, a } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    expect((await request(app).delete(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token))).status).toBe(204);
    expect((await request(app).delete(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token))).status).toBe(204);
    expect((await request(app).get(`${base(a.id)}/menu/items`).set(auth(a.token))).body.items).toHaveLength(0);
    expect((await request(app).get(`${base(a.id)}/menu/items?status=archived`).set(auth(a.token))).body.items).toHaveLength(1);
    // The name is free again while archived...
    expect((await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ ...salmon, slug: "salmon-new" })).status).toBe(201);
    // ...so the old item cannot come back with the same name.
    expect((await request(app).post(`${base(a.id)}/menu/items/grilled-salmon/restore`).set(auth(a.token))).status).toBe(409);
    expect((await request(app).delete(`${base(a.id)}/menu/items/salmon-new`).set(auth(a.token))).status).toBe(204);
    expect((await request(app).post(`${base(a.id)}/menu/items/grilled-salmon/restore`).set(auth(a.token))).body.status).toBe("active");
  });

  it("keeps restaurants apart: no cross-tenant read, write or list", async () => {
    const { app, a, b } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    expect((await request(app).get(`${base(a.id)}/menu/items`).set(auth(b.token))).status).toBe(404); // not a member
    expect((await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(b.token)).send({ priceCents: 1 })).status).toBe(404);
    expect((await request(app).get(`${base(b.id)}/menu/items/grilled-salmon`).set(auth(b.token))).status).toBe(404); // same slug does not exist in B
    expect((await request(app).get(`${base(b.id)}/menu/items`).set(auth(b.token))).body.items).toEqual([]);
    expect((await request(app).get(`${base(a.id)}/menu/items`)).status).toBe(401);
    // B may create the same slug at a different price without touching A.
    await request(app).post(`${base(b.id)}/menu/items`).set(auth(b.token)).send({ ...salmon, priceCents: 999 });
    expect((await request(app).get(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token))).body.priceCents).toBe(3800);
  });
});

describe("roles", () => {
  it("viewer/staff read only; manager writes and verifies; nobody gets billing from catalog roles", async () => {
    const { app, a, withRole } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    const viewer = await withRole(a.slug, "viewer");
    const staff = await withRole(a.slug, "staff");
    const manager = await withRole(a.slug, "manager");

    for (const t of [viewer, staff]) {
      expect((await request(app).get(`${base(a.id)}/menu/items`).set(auth(t))).status).toBe(200);
      expect((await request(app).get(`${base(a.id)}/hours`).set(auth(t))).status).toBe(200);
      expect((await request(app).post(`${base(a.id)}/menu/items`).set(auth(t)).send({ ...salmon, name: "X" })).status).toBe(403);
      expect((await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(t)).send({ priceCents: 1 })).status).toBe(403);
      expect((await request(app).delete(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(t))).status).toBe(403);
      expect((await request(app).put(`${base(a.id)}/menu/items/grilled-salmon/allergens`).set(auth(t)).send({ allergens: [], confirmed: true })).status).toBe(403);
      expect((await request(app).put(`${base(a.id)}/hours`).set(auth(t)).send({ weekly: [{ day: 1, periods: [{ opens: "11:00", closes: "22:00" }] }] })).status).toBe(403);
    }
    expect((await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(manager)).send({ priceCents: 4000 })).status).toBe(200);
    expect((await request(app).put(`${base(a.id)}/menu/items/grilled-salmon/allergens`).set(auth(manager)).send({ allergens: ["fish"], confirmed: true })).status).toBe(200);
    expect((await request(app).get(`${base(a.id)}/subscription`).set(auth(manager))).status).toBe(403);
  });
});

describe("allergen verification", () => {
  it("requires the explicit attestation, records the verifier from the SESSION, and is audited", async () => {
    const { app, a, store, withRole } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    const url = `${base(a.id)}/menu/items/grilled-salmon/allergens`;

    expect((await request(app).put(url).set(auth(a.token)).send({ allergens: ["fish"] })).status).toBe(400);
    expect((await request(app).put(url).set(auth(a.token)).send({ allergens: ["fish"], confirmed: false })).status).toBe(400);
    expect((await request(app).put(url).set(auth(a.token)).send({ allergens: ["gold"], confirmed: true })).status).toBe(400);
    expect((await request(app).put(url).set(auth(a.token)).send({ allergens: ["fish"], confirmed: true, verifiedBy: "Someone Else" })).status).toBe(400);

    const manager = await withRole(a.slug, "manager");
    const ok = await request(app).put(url).set(auth(manager)).send({ allergens: ["milk", "fish", "fish"], confirmed: true });
    expect(ok.status).toBe(200);
    expect(ok.body.allergens).toMatchObject({ declared: ["fish", "milk"], verified: true });
    expect(ok.body.allergens.verifiedBy).toMatch(/^The manager \(usr_/);
    expect(store.audit.some((e) => e.action === "menu_item.allergens_verified" && e.restaurantId === a.id)).toBe(true);
  });

  it("an empty declaration is a real, attested claim and also works", async () => {
    const { app, a } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ name: "Plain Rice", category: "Sides", priceCents: 300 });
    const r = await request(app).put(`${base(a.id)}/menu/items/plain-rice/allergens`).set(auth(a.token)).send({ allergens: [], confirmed: true });
    expect(r.body.allergens).toMatchObject({ declared: [], verified: true });
  });

  it("rejects labels that contradict the declaration, in both directions", async () => {
    const { app, a } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ name: "Green Bowl", category: "Mains", priceCents: 900, dietaryTags: ["vegan"] });
    const put = (allergens: string[]) => request(app).put(`${base(a.id)}/menu/items/green-bowl/allergens`).set(auth(a.token)).send({ allergens, confirmed: true });
    const bad = await put(["eggs"]);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("allergen_tag_conflict");
    expect((await put(["sesame"])).status).toBe(200);
    const patch = await request(app).patch(`${base(a.id)}/menu/items/green-bowl`).set(auth(a.token)).send({ dietaryTags: ["vegan", "gluten_free"] });
    expect(patch.status).toBe(200);
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ name: "Mac", category: "Mains", priceCents: 900 });
    await request(app).put(`${base(a.id)}/menu/items/mac/allergens`).set(auth(a.token)).send({ allergens: ["milk"], confirmed: true });
    expect((await request(app).patch(`${base(a.id)}/menu/items/mac`).set(auth(a.token)).send({ dietaryTags: ["dairy_free"] })).status).toBe(422);
  });

  it("price edits do not disturb verification; revoking returns the item to unverified and is audited", async () => {
    const { app, a, store } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    await request(app).put(`${base(a.id)}/menu/items/grilled-salmon/allergens`).set(auth(a.token)).send({ allergens: ["fish"], confirmed: true });
    const edited = await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token)).send({ priceCents: 5000 });
    expect(edited.body.allergens.verified).toBe(true);
    const revoked = await request(app).delete(`${base(a.id)}/menu/items/grilled-salmon/allergens/verification`).set(auth(a.token));
    expect(revoked.status).toBe(200);
    expect(revoked.body.allergens).toMatchObject({ verified: false, verifiedAt: null, verifiedBy: null });
    expect(store.audit.map((e) => e.action)).toContain("menu_item.allergens_unverified");
  });

  it("writes audit entries with before/after price and never leaks across tenants", async () => {
    const { app, a, b, store } = await setup();
    await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send(salmon);
    await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token)).send({ priceCents: 4200 });
    const entry = store.audit.find((e) => e.action === "menu_item.updated")!;
    expect(entry.restaurantId).toBe(a.id);
    expect(entry.metadata).toMatchObject({ fields: ["priceCents"], priceCents: { from: 3800, to: 4200 } });
    const bLogs = await request(app).get(`${base(b.id)}/audit-logs`).set(auth(b.token));
    expect(JSON.stringify(bLogs.body)).not.toContain("menu_item");
    // a no-op patch writes nothing
    const before = store.audit.length;
    await request(app).patch(`${base(a.id)}/menu/items/grilled-salmon`).set(auth(a.token)).send({ priceCents: 4200 });
    expect(store.audit.length).toBe(before);
  });
});

describe("opening hours API", () => {
  const put = (app: ReturnType<typeof createApp>, id: string, token: string, body: object) => request(app).put(`${base(id)}/hours`).set(auth(token)).send(body);
  const weekly = [{ day: 1, periods: [{ opens: "17:00", closes: "22:00" }, { opens: "11:00", closes: "14:00" }] }, { day: 6, periods: [{ opens: "18:00", closes: "01:00" }] }];

  it("reports unconfigured, then stores a normalised schedule and audits it", async () => {
    const { app, a, store } = await setup();
    expect((await request(app).get(`${base(a.id)}/hours`).set(auth(a.token))).body).toMatchObject({ configured: false, hours: null, timezone: "America/Antigua" });
    const r = await put(app, a.id, a.token, { weekly, exceptions: [{ date: "2026-12-25", closed: true, note: "Christmas" }] });
    expect(r.status).toBe(200);
    expect(r.body.hours.weekly[0].periods[0]).toEqual({ opens: "11:00", closes: "14:00" });
    expect(r.body.hours.exceptions[0]).toMatchObject({ date: "2026-12-25", closed: true, periods: [], note: "Christmas" });
    expect((await request(app).get(`${base(a.id)}/hours`).set(auth(a.token))).body.configured).toBe(true);
    expect(store.audit.some((e) => e.action === "hours.updated")).toBe(true);
  });

  it("rejects malformed and impossible schedules", async () => {
    const { app, a } = await setup();
    expect((await put(app, a.id, a.token, { weekly: [{ day: 9, periods: [] }] })).status).toBe(400);
    expect((await put(app, a.id, a.token, { weekly: [{ day: 1, periods: [{ opens: "25:00", closes: "22:00" }] }] })).status).toBe(400);
    expect((await put(app, a.id, a.token, { weekly: [{ day: 1, periods: [{ opens: "10:00", closes: "10:00" }] }] })).status).toBe(400);
    const closedWeek = await put(app, a.id, a.token, { weekly: [{ day: 1, periods: [] }] });
    expect(closedWeek.status).toBe(422);
    expect(closedWeek.body.error.code).toBe("invalid_hours");
    expect((await put(app, a.id, a.token, { weekly: [{ day: 1, periods: [{ opens: "10:00", closes: "15:00" }, { opens: "14:00", closes: "18:00" }] }] })).status).toBe(422);
  });

  it("is tenant-scoped", async () => {
    const { app, a, b } = await setup();
    await put(app, a.id, a.token, { weekly });
    expect((await request(app).get(`${base(b.id)}/hours`).set(auth(b.token))).body.configured).toBe(false);
    expect((await put(app, a.id, b.token, { weekly })).status).toBe(404);
  });
});

describe("write rate limit", () => {
  it("throttles mutations per user but not reads", async () => {
    const { app, a } = await setup({ ADMIN_WRITE_RATE_LIMIT_PER_MIN: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).post(`${base(a.id)}/menu/items`).set(auth(a.token)).send({ name: `Item ${i}`, category: "X", priceCents: 1 })).status);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    expect((await request(app).get(`${base(a.id)}/menu/items`).set(auth(a.token))).status).toBe(200);
  });
});
