/**
 * Runs against a REAL MongoDB (CI service container or `docker compose up mongo`).
 * Skipped automatically when MONGODB_TEST_URI is not set.
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

describe.skipIf(!uri)("knowledge base against MongoDB", () => {
  let client: MongoClient;
  let db: Db;
  let repos: Repositories;
  const tenant = (id: typeof A) => repos.forTenant({ restaurantId: id, retention: {} }).knowledge;

  beforeAll(async () => {
    client = new MongoClient(uri!);
    await client.connect();
    db = client.db(`it_kb_${Date.now()}`);
    await runMigrations(db);
    repos = createRepositories(db, retention);
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it("the same FAQ slug and policy kind can exist in two restaurants with different content", async () => {
    await tenant(A).createFaq({ slug: "wifi", question: "Free WiFi?", answer: "Yes." });
    await tenant(B).createFaq({ slug: "wifi", question: "Free WiFi?", answer: "No." });
    await tenant(A).savePolicy("pets", { title: "Pets", body: "Terrace only." });
    await tenant(B).savePolicy("pets", { title: "Pets", body: "Never." });
    expect((await tenant(A).findAnyFaqBySlug("wifi"))?.answer).toBe("Yes.");
    expect((await tenant(B).findAnyFaqBySlug("wifi"))?.answer).toBe("No.");
    expect((await tenant(A).getAnyPolicy("pets"))?.body).toBe("Terrace only.");
    expect((await tenant(B).getAnyPolicy("pets"))?.body).toBe("Never.");
  });

  it("a duplicate FAQ slug inside ONE restaurant is rejected by the unique index", async () => {
    await expect(tenant(A).createFaq({ slug: "wifi", question: "Again?", answer: "x" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("the assistant's reads return published content only", async () => {
    expect(await tenant(A).listPublishedFaqs()).toEqual([]);
    expect(await tenant(A).getPublishedPolicy("pets")).toBeNull();

    await tenant(A).setFaqStatus("wifi", "published");
    await tenant(A).setPolicyStatus("pets", "published");
    expect((await tenant(A).listPublishedFaqs()).map((f) => f.slug)).toEqual(["wifi"]);
    expect((await tenant(A).getPublishedPolicy("pets"))?.body).toBe("Terrace only.");
    // B published nothing, so B still sees nothing: publishing in A is invisible to B.
    expect(await tenant(B).listPublishedFaqs()).toEqual([]);
    expect(await tenant(B).getPublishedPolicy("pets")).toBeNull();

    await tenant(A).setFaqStatus("wifi", "archived");
    expect(await tenant(A).listPublishedFaqs()).toEqual([]);
  });

  it("publishing sets publishedAt and unpublishing removes it", async () => {
    await tenant(A).setFaqStatus("wifi", "published");
    expect((await tenant(A).findAnyFaqBySlug("wifi"))?.publishedAt).toBeInstanceOf(Date);
    await tenant(A).setFaqStatus("wifi", "draft");
    expect((await tenant(A).findAnyFaqBySlug("wifi"))?.publishedAt).toBeUndefined();
  });

  it("editing a policy keeps its status; one policy per kind", async () => {
    await tenant(A).setPolicyStatus("pets", "published");
    await tenant(A).savePolicy("pets", { title: "Pets", body: "Small dogs only." });
    expect(await tenant(A).getAnyPolicy("pets")).toMatchObject({ status: "published", body: "Small dogs only." });
    expect(await db.collection("policies").countDocuments({ restaurantId: A, kind: "pets" })).toBe(1);
  });

  it("an update with $unset removes the category; the live count ignores archived entries", async () => {
    await tenant(A).updateFaq("wifi", { category: "General" });
    expect((await tenant(A).findAnyFaqBySlug("wifi"))?.category).toBe("General");
    await tenant(A).updateFaq("wifi", { category: null });
    expect((await tenant(A).findAnyFaqBySlug("wifi"))?.category).toBeUndefined();

    await tenant(A).setFaqStatus("wifi", "archived");
    expect(await tenant(A).countLiveFaqs()).toBe(0);
    expect((await tenant(A).listFaqsForAdmin({ status: "live", limit: 10 }))).toEqual([]);
    expect((await tenant(A).listFaqsForAdmin({ status: "all", limit: 10 })).map((f) => f.slug)).toEqual(["wifi"]);
  });

  it("the database itself rejects documents with a bad tenant id, status or policy kind (validators)", async () => {
    const now = new Date();
    const faq = { slug: "x", question: "q", answer: "a", keywords: [], status: "draft", createdAt: now, updatedAt: now };
    await expect(db.collection("faqs").insertOne({ ...faq })).rejects.toThrow(); // no restaurantId
    await expect(db.collection("faqs").insertOne({ ...faq, restaurantId: "nope" })).rejects.toThrow();
    await expect(db.collection("faqs").insertOne({ ...faq, restaurantId: A, status: "live" })).rejects.toThrow();
    const policy = { title: "t", body: "b", status: "draft", createdAt: now, updatedAt: now };
    await expect(db.collection("policies").insertOne({ ...policy, restaurantId: A, kind: "free_drinks" })).rejects.toThrow();
  });
});
