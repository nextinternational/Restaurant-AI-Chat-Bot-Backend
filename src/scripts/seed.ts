import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { getCollections } from "../db/collections.js";
import { runMigrations } from "../db/migrate.js";
import { parseRestaurantId } from "../domain/ids.js";
import { createRepositories } from "../repositories/index.js";
import { generateWidgetKey } from "../security/tokens.js";

const env = loadEnv();
if (env.NODE_ENV === "production") {
  process.stderr.write("Refusing to seed demo data in production.\n");
  process.exit(1);
}

const database = await connectMongo(env);
try {
  await runMigrations(database.db);
  const cols = getCollections(database.db);
  const repos = createRepositories(database.db, env);
  const now = new Date();

  const demo = [
    { id: "rest_001", slug: "harbor-grill", name: "Harbor Grill", origin: "http://localhost:8080",
      item: { slug: "grilled-salmon", name: "Grilled Salmon", priceCents: 3800 },
      wifi: "Yes, it is free. Ask your server for the password.", pets: "Small dogs are welcome on the terrace only." },
    { id: "rest_002", slug: "olive-garden-demo", name: "Olive Demo", origin: "http://localhost:8081",
      item: { slug: "grilled-salmon", name: "Grilled Salmon", priceCents: 2900 }, // same slug, different price: isolation check
      wifi: "Sorry, we do not offer WiFi.", pets: "Pets are not allowed inside or on the terrace." },
  ];

  for (const d of demo) {
    const restaurantId = parseRestaurantId(d.id);
    await cols.restaurants.updateOne(
      { restaurantId },
      { $setOnInsert: { restaurantId, slug: d.slug, name: d.name, status: "active", timezone: "UTC", currency: "USD",
          defaultLocale: "en", retention: {}, monthlyAiBudgetMicros: 0, createdAt: now, updatedAt: now,
          location: { address: `1 Demo Road (${d.name})`, phone: "+1 555 0100" } } },
      { upsert: true },
    );
    const publicKey = generateWidgetKey();
    if (!(await cols.widgetKeys.findOne({ restaurantId, status: "active" }))) {
      await cols.widgetKeys.insertOne({ restaurantId, publicKey, allowedOrigins: [d.origin], status: "active", label: "demo", createdAt: now });
      process.stdout.write(`${d.id} widget key: ${publicKey}\n`);
    }
    const t = repos.forTenant({ restaurantId, retention: {} });
    if ((await t.menu.findBySlug(d.item.slug)) === null) {
      await t.menu.create({ ...d.item, category: "Mains", currency: "USD", status: "active", available: true,
        dietaryTags: [], allergens: ["fish"], allergensVerified: false });
    }
    // One dish with human-verified allergens, so the "verified" path can be tried next to the "unverified" salmon.
    if ((await t.menu.findBySlug("verified-pasta")) === null) {
      await t.menu.create({ slug: "verified-pasta", name: "Verified Pasta", priceCents: 2200, category: "Mains", currency: "USD", status: "active",
        available: true, dietaryTags: ["vegetarian"], allergens: [], allergensVerified: false });
      await t.menu.setAllergens("verified-pasta", ["cereals_gluten", "milk", "eggs"], "seed script (demo only)");
    }
    // Same slug and kind in both restaurants with different content: published demo knowledge for the isolation check.
    if ((await t.knowledge.findAnyFaqBySlug("wifi")) === null) {
      await t.knowledge.createFaq({ slug: "wifi", question: "Do you have free WiFi?", answer: d.wifi, keywords: ["internet", "wi-fi"] });
      await t.knowledge.setFaqStatus("wifi", "published");
    }
    if ((await t.knowledge.getAnyPolicy("pets")) === null) {
      await t.knowledge.savePolicy("pets", { title: "Pets policy", body: d.pets });
      await t.knowledge.setPolicyStatus("pets", "published");
    }
    if ((await t.hours.get()) === null) {
      await t.hours.replace({
        weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, periods: [{ opens: "10:00", closes: "22:00" }] })),
        exceptions: [],
      });
    }
  }
  process.stdout.write("seeded demo restaurants\n");
} finally {
  await database.close();
}
