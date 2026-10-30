/**
 * Runs against a REAL MongoDB (set MONGODB_TEST_URI). Verifies what the in-memory double cannot:
 * the JSON-schema validators, $unset handling, cursor ordering and tenant scoping of the Step 7 repository methods.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { runMigrations } from "../../src/db/migrate.js";
import { createRepositories, type Repositories } from "../../src/repositories/index.js";
import { parseRestaurantId } from "../../src/domain/ids.js";

const uri = process.env.MONGODB_TEST_URI;
const retention = { RETENTION_MESSAGES_DAYS: 30, RETENTION_CONVERSATIONS_DAYS: 90, RETENTION_USAGE_MONTHS: 13 };
const A = parseRestaurantId("rest_001");
const B = parseRestaurantId("rest_002");

describe.skipIf(!uri)("catalog repositories against MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let repos: Repositories;
  beforeAll(async () => {
    client = new MongoClient(uri!);
    await client.connect();
    db = client.db(`it_catalog_${Date.now()}`);
    await runMigrations(db);
    repos = createRepositories(db, retention);
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  const input = (slug: string, name: string) => ({
    slug, name, category: "Mains", priceCents: 3800, currency: "USD", status: "active" as const, available: true,
    dietaryTags: [], allergens: [], allergensVerified: false,
  });

  it("updates, unsets, archives, pages and verifies within one tenant only", async () => {
    const a = repos.forTenant({ restaurantId: A, retention: {} });
    const b = repos.forTenant({ restaurantId: B, retention: {} });
    await a.menu.create({ ...input("salmon", "Grilled Salmon"), description: "Fresh" });
    await a.menu.create(input("tuna", "Tuna"));
    await b.menu.create(input("salmon", "Grilled Salmon"));

    const upd = await a.menu.update("salmon", { priceCents: 4200, description: null });
    expect(upd?.changed.sort()).toEqual(["description", "priceCents"]);
    const doc = await a.menu.findAnyBySlug("salmon");
    expect(doc?.priceCents).toBe(4200);
    expect(doc?.description).toBeUndefined();
    expect((await b.menu.findAnyBySlug("salmon"))?.priceCents).toBe(3800);

    expect(await a.menu.update("missing", { available: false })).toBeNull();
    expect((await a.menu.listForAdmin({ status: "all", limit: 1 })).map((i) => i.slug)).toEqual(["salmon"]);
    expect((await a.menu.listForAdmin({ status: "all", after: "salmon", limit: 5 })).map((i) => i.slug)).toEqual(["tuna"]);

    await a.menu.setAllergens("salmon", ["fish"], "Tester (usr_x)");
    expect((await a.menu.findAnyBySlug("salmon"))?.allergensVerified).toBe(true);
    await a.menu.revokeAllergenVerification("salmon");
    const revoked = await a.menu.findAnyBySlug("salmon");
    expect(revoked?.allergensVerified).toBe(false);
    expect(revoked?.allergensVerifiedBy).toBeUndefined();

    await a.menu.setStatus("tuna", "archived");
    expect(await a.menu.findBySlug("tuna")).toBeNull();
    expect((await b.menu.listForAdmin({ status: "all", limit: 10 })).map((i) => i.slug)).toEqual(["salmon"]);
  });
});
