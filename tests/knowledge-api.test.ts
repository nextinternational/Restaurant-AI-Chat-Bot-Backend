import { describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { can, PERMISSIONS, ROLES } from "../src/auth/permissions.js";
import { POLICY_KINDS } from "../src/domain/schemas.js";
import { KnowledgeAdminService } from "../src/services/knowledge/knowledgeAdminService.js";
import { ProvisioningService } from "../src/services/provisioningService.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";
import { MemoryKnowledgeGateway } from "./helpers/memoryKnowledge.js";
import { NOW } from "./helpers/memoryChat.js";

const logger = pino({ level: "silent" });
const PASSWORD = "correct horse battery";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function setup(extra: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000",
    AUTH_RATE_LIMIT_PER_15MIN: "1000", ADMIN_WRITE_RATE_LIMIT_PER_MIN: "1000", ALLOW_PUBLIC_SIGNUP: "true", ...extra,
  });
  const store = new MemoryAccountStore();
  const gateway = new MemoryKnowledgeGateway();
  const app = createApp({ env, logger, readinessChecks: [], accounts: store, knowledge: new KnowledgeAdminService(gateway, store, () => NOW) });
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

const base = (id: string) => `/v1/restaurants/${id}`;
/** Signup writes its own audit entries; these tests only care about knowledge-base actions. */
const knowledgeAudit = (store: MemoryAccountStore) => store.audit.filter((e) => e.action.startsWith("faq.") || e.action.startsWith("policy."));
const kids = { question: "Are children welcome?", answer: "Yes, we have high chairs and a kids menu.", keywords: ["kids", "baby"] };

describe("permissions", () => {
  it("owners can do everything; viewers and staff can read knowledge but never write it", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
    for (const r of ROLES) expect(can(r, "knowledge:read")).toBe(true);
    expect(can("manager", "knowledge:write")).toBe(true);
    expect(can("staff", "knowledge:write")).toBe(false);
    expect(can("viewer", "knowledge:write")).toBe(false);
  });
});

describe("FAQ management API", () => {
  it("creates DRAFTS, derives a slug, and never returns the tenant id", async () => {
    const { app, a } = await setup();
    const created = await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send(kids);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: "are-children-welcome", status: "draft", publishedAt: null, category: null, keywords: ["kids", "baby"] });
    expect(JSON.stringify(created.body)).not.toContain("restaurantId");

    // The same question again gets a distinct, random-suffixed slug instead of a conflict.
    const again = await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send(kids);
    expect(again.status).toBe(201);
    expect(again.body.slug).toMatch(/^are-children-welcome-[0-9a-f]{6}$/);
  });

  it("accepts Arabic questions (no Latin letters to derive a slug from)", async () => {
    const { app, a } = await setup();
    const r = await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ question: "هل يوجد واي فاي؟", answer: "نعم، مجاناً." });
    expect(r.status).toBe(201);
    expect(r.body.slug.startsWith("faq")).toBe(true); // "faq", plus a random suffix if the name was already taken
    expect(r.body.question).toBe("هل يوجد واي فاي؟");
  });

  it("an explicit slug that is taken is a 409; bad slugs are 400", async () => {
    const { app, a } = await setup();
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" })).status).toBe(201);
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" })).status).toBe(409);
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "Bad Slug!" })).status).toBe(400);
  });

  it("is strict: unknown fields, a tenant id or status in the body are rejected", async () => {
    const { app, a } = await setup();
    for (const extra of [{ restaurantId: "rest_999" }, { status: "published" }, { publishedAt: "2026-01-01" }, { nope: 1 }]) {
      expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, ...extra })).status).toBe(400);
    }
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ question: "ab", answer: "x" })).status).toBe(400);
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, answer: "x".repeat(2001) })).status).toBe(400);
    expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) })).status).toBe(400);
  });

  it("walks the lifecycle draft -> published -> draft -> archived -> restored (as a draft), idempotently, with audit entries", async () => {
    const { app, a, store } = await setup();
    await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" });
    const url = `${base(a.id)}/faqs/kids`;

    const pub = await request(app).post(`${url}/publish`).set(auth(a.token));
    expect(pub.body).toMatchObject({ status: "published" });
    expect(pub.body.publishedAt).not.toBeNull();
    expect((await request(app).post(`${url}/publish`).set(auth(a.token))).body.status).toBe("published"); // idempotent

    expect((await request(app).post(`${url}/unpublish`).set(auth(a.token))).body).toMatchObject({ status: "draft", publishedAt: null });
    expect((await request(app).post(`${url}/unpublish`).set(auth(a.token))).body.status).toBe("draft");

    await request(app).post(`${url}/publish`).set(auth(a.token));
    expect((await request(app).delete(url).set(auth(a.token))).status).toBe(204);
    expect((await request(app).delete(url).set(auth(a.token))).status).toBe(204); // idempotent
    expect((await request(app).get(url).set(auth(a.token))).body.status).toBe("archived");

    // An archived entry can be neither edited nor published until it is restored, and restoring does NOT republish it.
    expect((await request(app).patch(url).set(auth(a.token)).send({ answer: "New" })).status).toBe(409);
    expect((await request(app).post(`${url}/publish`).set(auth(a.token))).status).toBe(409);
    const restored = await request(app).post(`${url}/restore`).set(auth(a.token));
    expect(restored.body).toMatchObject({ status: "draft", publishedAt: null });

    expect(knowledgeAudit(store).filter((e) => e.restaurantId === a.id).map((e) => e.action)).toEqual([
      "faq.created", "faq.published", "faq.unpublished", "faq.published", "faq.archived", "faq.restored",
    ]);
  });

  it("edits keep the status, are audited by field name only, and flag live edits", async () => {
    const { app, a, store } = await setup();
    await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" });
    await request(app).post(`${base(a.id)}/faqs/kids/publish`).set(auth(a.token));

    const patched = await request(app).patch(`${base(a.id)}/faqs/kids`).set(auth(a.token)).send({ answer: "Yes, and a play corner.", category: "Family" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: "published", answer: "Yes, and a play corner.", category: "Family" });
    expect((await request(app).patch(`${base(a.id)}/faqs/kids`).set(auth(a.token)).send({ category: null })).body.category).toBeNull();
    expect((await request(app).patch(`${base(a.id)}/faqs/kids`).set(auth(a.token)).send({})).status).toBe(400);
    expect((await request(app).patch(`${base(a.id)}/faqs/kids`).set(auth(a.token)).send({ status: "published" })).status).toBe(400);

    const edit = store.audit.find((e) => e.action === "faq.updated")!;
    expect(edit.metadata).toEqual({ fields: ["answer", "category"], live: true });
    expect(JSON.stringify(store.audit)).not.toContain("play corner"); // content never lands in the audit trail

    // A no-op edit writes no audit entry.
    const before = knowledgeAudit(store).length;
    await request(app).patch(`${base(a.id)}/faqs/kids`).set(auth(a.token)).send({ keywords: ["kids", "baby"] });
    expect(knowledgeAudit(store)).toHaveLength(before);
  });

  it("lists with a status filter and cursor pagination; archived entries only on request", async () => {
    const { app, a } = await setup();
    for (const s of ["a", "b", "c"]) await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ question: `Question ${s}?`, answer: "x", slug: s });
    await request(app).post(`${base(a.id)}/faqs/b/publish`).set(auth(a.token));
    await request(app).delete(`${base(a.id)}/faqs/c`).set(auth(a.token));

    const live = await request(app).get(`${base(a.id)}/faqs`).set(auth(a.token));
    expect(live.body.faqs.map((f: { slug: string }) => f.slug)).toEqual(["a", "b"]);
    expect((await request(app).get(`${base(a.id)}/faqs?status=published`).set(auth(a.token))).body.faqs).toHaveLength(1);
    expect((await request(app).get(`${base(a.id)}/faqs?status=archived`).set(auth(a.token))).body.faqs).toHaveLength(1);
    expect((await request(app).get(`${base(a.id)}/faqs?status=all`).set(auth(a.token))).body.faqs).toHaveLength(3);

    const p1 = await request(app).get(`${base(a.id)}/faqs?status=all&limit=2`).set(auth(a.token));
    expect(p1.body.nextCursor).toBe("b");
    const p2 = await request(app).get(`${base(a.id)}/faqs?status=all&limit=2&after=b`).set(auth(a.token));
    expect(p2.body.faqs.map((f: { slug: string }) => f.slug)).toEqual(["c"]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await request(app).get(`${base(a.id)}/faqs?status=bogus`).set(auth(a.token))).status).toBe(400);
  });

  it("caps live FAQs per restaurant; archiving frees a slot and restoring needs room", async () => {
    const { app, a } = await setup();
    const make = (i: number) => request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ question: `Question number ${i}?`, answer: "x", slug: `q-${i}` });
    for (let i = 0; i < 100; i++) expect((await make(i)).status).toBe(201);
    const over = await make(100);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("faq_limit_reached");

    await request(app).delete(`${base(a.id)}/faqs/q-0`).set(auth(a.token));
    expect((await make(100)).status).toBe(201);
    expect((await request(app).post(`${base(a.id)}/faqs/q-0/restore`).set(auth(a.token))).status).toBe(409); // full again
  }, 30_000);

  it("enforces roles: viewer/staff read only, manager writes, anonymous is rejected", async () => {
    const { app, a, withRole } = await setup();
    await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" });
    const manager = await withRole(a.slug, "manager");
    const staff = await withRole(a.slug, "staff");
    const viewer = await withRole(a.slug, "viewer");

    for (const t of [staff, viewer]) {
      expect((await request(app).get(`${base(a.id)}/faqs`).set(auth(t))).status).toBe(200);
      expect((await request(app).get(`${base(a.id)}/policies`).set(auth(t))).status).toBe(200);
      expect((await request(app).post(`${base(a.id)}/faqs`).set(auth(t)).send(kids)).status).toBe(403);
      expect((await request(app).post(`${base(a.id)}/faqs/kids/publish`).set(auth(t))).status).toBe(403);
      expect((await request(app).delete(`${base(a.id)}/faqs/kids`).set(auth(t))).status).toBe(403);
      expect((await request(app).put(`${base(a.id)}/policies/pets`).set(auth(t)).send({ body: "x" })).status).toBe(403);
    }
    expect((await request(app).post(`${base(a.id)}/faqs/kids/publish`).set(auth(manager))).status).toBe(200);
    expect((await request(app).get(`${base(a.id)}/faqs`)).status).toBe(401);
  });

  it("isolates tenants: B cannot see, edit or publish A's FAQs, whatever id it puts in the URL", async () => {
    const { app, a, b, gateway } = await setup();
    await request(app).post(`${base(a.id)}/faqs`).set(auth(a.token)).send({ ...kids, slug: "kids" });
    await request(app).put(`${base(a.id)}/policies/pets`).set(auth(a.token)).send({ body: "No pets." });

    // B's own listing is empty and its own slug space is separate.
    expect((await request(app).get(`${base(b.id)}/faqs`).set(auth(b.token))).body.faqs).toEqual([]);
    expect((await request(app).get(`${base(b.id)}/faqs/kids`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).post(`${base(b.id)}/faqs/kids/publish`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).get(`${base(b.id)}/policies/pets`).set(auth(b.token))).status).toBe(404);

    // Using A's id with B's token is a 404 (not a 403): non-members learn nothing.
    expect((await request(app).get(`${base(a.id)}/faqs`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).put(`${base(a.id)}/policies/pets`).set(auth(b.token)).send({ body: "Pets welcome!" })).status).toBe(404);

    expect(gateway.tenants.get(a.id)!.faqs).toHaveLength(1);
    expect(gateway.tenants.get(a.id)!.policies[0]!.body).toBe("No pets.");
    expect(gateway.tenants.get(b.id)?.faqs ?? []).toHaveLength(0);
  });
});

describe("policy management API", () => {
  it("starts unconfigured, saves a DRAFT with a default title, publishes and unpublishes", async () => {
    const { app, a, store } = await setup();
    const empty = await request(app).get(`${base(a.id)}/policies`).set(auth(a.token));
    expect(empty.body.policies).toEqual([]);
    expect(empty.body.unconfiguredKinds).toEqual([...POLICY_KINDS]);

    const saved = await request(app).put(`${base(a.id)}/policies/cancellation`).set(auth(a.token)).send({ body: "Free cancellation up to 24 hours before." });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ kind: "cancellation", title: "Cancellation policy", status: "draft", publishedAt: null });
    expect(JSON.stringify(saved.body)).not.toContain("restaurantId");

    expect((await request(app).post(`${base(a.id)}/policies/cancellation/publish`).set(auth(a.token))).body.status).toBe("published");
    expect((await request(app).post(`${base(a.id)}/policies/cancellation/publish`).set(auth(a.token))).body.status).toBe("published");
    expect((await request(app).post(`${base(a.id)}/policies/cancellation/unpublish`).set(auth(a.token))).body).toMatchObject({ status: "draft", publishedAt: null });

    const list = await request(app).get(`${base(a.id)}/policies`).set(auth(a.token));
    expect(list.body.policies).toHaveLength(1);
    expect(list.body.unconfiguredKinds).not.toContain("cancellation");
    expect(knowledgeAudit(store).map((e) => e.action)).toEqual(["policy.created", "policy.published", "policy.unpublished"]);
  });

  it("editing keeps the status and the title; a live edit is flagged in the audit trail", async () => {
    const { app, a, store } = await setup();
    await request(app).put(`${base(a.id)}/policies/parking`).set(auth(a.token)).send({ title: "Where to park", body: "Free lot behind the building." });
    await request(app).post(`${base(a.id)}/policies/parking/publish`).set(auth(a.token));
    const edited = await request(app).put(`${base(a.id)}/policies/parking`).set(auth(a.token)).send({ body: "Free lot, 30 spaces." });
    expect(edited.body).toMatchObject({ title: "Where to park", body: "Free lot, 30 spaces.", status: "published" });
    expect(store.audit.at(-1)).toMatchObject({ action: "policy.updated", metadata: { status: "published", live: true } });
  });

  it("only known kinds exist; unknown kinds and unsaved policies are 404; bodies are strict", async () => {
    const { app, a } = await setup();
    expect((await request(app).put(`${base(a.id)}/policies/free_drinks`).set(auth(a.token)).send({ body: "x" })).status).toBe(404);
    expect((await request(app).get(`${base(a.id)}/policies/free_drinks`).set(auth(a.token))).status).toBe(404);
    expect((await request(app).get(`${base(a.id)}/policies/pets`).set(auth(a.token))).status).toBe(404);
    expect((await request(app).post(`${base(a.id)}/policies/pets/publish`).set(auth(a.token))).status).toBe(404);
    expect((await request(app).put(`${base(a.id)}/policies/pets`).set(auth(a.token)).send({})).status).toBe(400);
    expect((await request(app).put(`${base(a.id)}/policies/pets`).set(auth(a.token)).send({ body: "x", status: "published" })).status).toBe(400);
    expect((await request(app).put(`${base(a.id)}/policies/pets`).set(auth(a.token)).send({ body: "x", kind: "refund" })).status).toBe(400);
  });
});
