import { describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { can } from "../src/auth/permissions.js";
import { parseRestaurantId } from "../src/domain/ids.js";
import { ProvisioningService } from "../src/services/provisioningService.js";
import { UsageAdminService } from "../src/services/usage/usageAdminService.js";
import type { UsageGateway } from "../src/services/usage/gateway.js";
import { MemoryAccountStore } from "./helpers/memoryAccountStore.js";
import { NOW } from "./helpers/memoryChat.js";

const PASSWORD = "correct horse battery";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

interface Row { conv: string; model: string; inT: number; outT: number; cost: number; at: Date }

/** Per-tenant rows: a context built for tenant A cannot see tenant B's array. */
function memoryUsage(rowsByTenant: Map<string, Row[]>): UsageGateway {
  return {
    async tenantContext(restaurantId) {
      const rows = rowsByTenant.get(restaurantId) ?? [];
      const within = (from: Date, to: Date) => rows.filter((r) => r.at >= from && r.at < to);
      const sum = (rs: Row[]) => ({ requests: rs.length, inputTokens: rs.reduce((a, r) => a + r.inT, 0), outputTokens: rs.reduce((a, r) => a + r.outT, 0), estimatedCostMicros: rs.reduce((a, r) => a + r.cost, 0) });
      return {
        restaurant: { restaurantId: parseRestaurantId(restaurantId), monthlyAiBudgetMicros: 15_000_000 },
        usage: {
          totals: async (f, t) => sum(within(f, t)),
          byModel: async (f, t) => [...new Set(within(f, t).map((r) => r.model))].map((model) => ({ model, ...sum(within(f, t).filter((r) => r.model === model)) })),
          topConversations: async (f, t, limit) =>
            [...new Set(within(f, t).map((r) => r.conv))]
              .map((conv) => { const rs = within(f, t).filter((r) => r.conv === conv); return { conversationId: conv, ...sum(rs), firstAt: rs[0]!.at, lastAt: rs.at(-1)!.at }; })
              .sort((x, y) => y.estimatedCostMicros - x.estimatedCostMicros).slice(0, limit),
        },
      };
    },
  };
}

async function setup() {
  const env = loadEnv({ NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000", AUTH_RATE_LIMIT_PER_15MIN: "1000", ALLOW_PUBLIC_SIGNUP: "true" });
  const store = new MemoryAccountStore();
  const rows = new Map<string, Row[]>();
  const app = createApp({ env, logger: pino({ level: "silent" }), readinessChecks: [], accounts: store, usage: new UsageAdminService(memoryUsage(rows), () => NOW) });
  const prov = new ProvisioningService(store, { allowInsecureLocalhostOrigins: false }, pino({ level: "silent" }));
  const signup = async (n: number) => {
    const r = await request(app).post("/v1/auth/signup").send({ email: `o${n}@example.com`, password: PASSWORD, name: `Owner ${n}`, restaurantName: `Place ${n}`, timezone: "Asia/Dubai" });
    expect(r.status).toBe(201);
    const id = r.body.restaurants[0].restaurantId as string;
    return { token: r.body.token as string, id, slug: store.restaurants.find((x) => x.restaurantId === id)!.slug };
  };
  return { app, rows, prov, signup };
}

const d = (s: string) => new Date(s);

describe("usage report API", () => {
  it("reports cost per restaurant, model and conversation for the current month", async () => {
    const { app, rows, signup } = await setup();
    const a = await signup(1);
    const b = await signup(2);
    rows.set(a.id, [
      { conv: "c1", model: "m1", inT: 1000, outT: 200, cost: 270, at: d("2026-10-02T10:00:00Z") },
      { conv: "c1", model: "m1", inT: 500, outT: 100, cost: 135, at: d("2026-10-02T10:01:00Z") },
      { conv: "c2", model: "m2", inT: 100, outT: 10, cost: 21, at: d("2026-10-05T10:00:00Z") },
      { conv: "old", model: "m1", inT: 9, outT: 9, cost: 9, at: d("2026-09-30T23:59:59Z") },
    ]);
    rows.set(b.id, [{ conv: "bb", model: "m1", inT: 1, outT: 1, cost: 999_999, at: d("2026-10-03T10:00:00Z") }]);

    const res = await request(app).get(`/v1/restaurants/${a.id}/usage`).set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ requests: 3, inputTokens: 1600, outputTokens: 310, estimatedCostMicros: 426 });
    expect(res.body.monthlyBudgetMicros).toBe(15_000_000);
    expect(res.body.period.from).toBe("2026-10-01T00:00:00.000Z");
    expect(res.body.topConversations.map((c: { conversationId: string }) => c.conversationId)).toEqual(["c1", "c2"]);
    expect(res.body.byModel).toHaveLength(2);
    // Nothing from restaurant B, in any form.
    expect(JSON.stringify(res.body)).not.toContain("bb");
    expect(JSON.stringify(res.body)).not.toContain("999999");
  });

  it("honours an explicit range and limit, and rejects a reversed or malformed one", async () => {
    const { app, rows, signup } = await setup();
    const a = await signup(1);
    rows.set(a.id, [
      { conv: "c1", model: "m1", inT: 1, outT: 1, cost: 5, at: d("2026-09-10T10:00:00Z") },
      { conv: "c2", model: "m1", inT: 1, outT: 1, cost: 7, at: d("2026-09-11T10:00:00Z") },
    ]);
    const ok = await request(app).get(`/v1/restaurants/${a.id}/usage?from=2026-09-01&to=2026-10-01&limit=1`).set(auth(a.token));
    expect(ok.status).toBe(200);
    expect(ok.body.topConversations).toHaveLength(1);
    expect(ok.body.topConversations[0].conversationId).toBe("c2");
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage?from=2026-10-02&to=2026-10-01`).set(auth(a.token))).status).toBe(400);
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage?limit=0`).set(auth(a.token))).status).toBe(400);
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage?from=garbage`).set(auth(a.token))).status).toBe(400);
  });

  it("is hidden from other tenants (404), from anonymous callers (401) and from roles without usage:read", async () => {
    const { app, signup, prov } = await setup();
    const a = await signup(1);
    const b = await signup(2);
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage`)).status).toBe(401);

    expect(can("staff", "usage:read")).toBe(false);
    await prov.addStaff({ restaurantSlug: a.slug, email: "staff@example.com", name: "Staff", role: "staff", password: PASSWORD });
    const staff = (await request(app).post("/v1/auth/login").send({ email: "staff@example.com", password: PASSWORD })).body.token as string;
    expect((await request(app).get(`/v1/restaurants/${a.id}/usage`).set(auth(staff))).status).toBe(403);
  });
});
