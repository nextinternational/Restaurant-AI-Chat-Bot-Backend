import type { Db } from "mongodb";
import { COLLECTIONS } from "../collections.js";

/**
 * 1) Fixes the `plans` validator: the Node driver stores whole JS numbers as int32, so requiring
 *    `long` for monthlyAiBudgetMicros would reject every normal value.
 * 2) Seeds the default plans. `$setOnInsert` means re-running (or editing prices later) never overwrites.
 *
 * PRICES BELOW ARE PLACEHOLDERS. Set real prices before selling; billing is not wired up yet.
 */
export async function up(db: Db): Promise<void> {
  const intMin0 = { bsonType: ["int", "long"], minimum: 0 };
  await db.command({
    collMod: COLLECTIONS.plans,
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["code", "name", "monthlyPriceCents", "currency", "monthlyMessageLimit", "monthlyAiBudgetMicros", "features", "active", "createdAt", "updatedAt"],
        properties: {
          code: { bsonType: "string", pattern: "^[a-z0-9-]+$" },
          monthlyPriceCents: intMin0,
          monthlyMessageLimit: intMin0,
          monthlyAiBudgetMicros: intMin0,
          active: { bsonType: "bool" },
        },
      },
    },
    validationLevel: "strict",
    validationAction: "error",
  });

  const now = new Date();
  const plans = [
    { code: "starter", name: "Starter", monthlyPriceCents: 4900, monthlyMessageLimit: 1000, monthlyAiBudgetMicros: 5_000_000, features: ["chat_widget", "menu", "opening_hours"] },
    { code: "growth", name: "Growth", monthlyPriceCents: 12900, monthlyMessageLimit: 5000, monthlyAiBudgetMicros: 20_000_000, features: ["chat_widget", "menu", "opening_hours", "human_handoff", "analytics"] },
  ];
  for (const p of plans) {
    await db.collection(COLLECTIONS.plans).updateOne(
      { code: p.code },
      { $setOnInsert: { ...p, currency: "USD", active: true, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  }
}
