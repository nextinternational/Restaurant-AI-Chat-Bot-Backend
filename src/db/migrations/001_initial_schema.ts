import type { Db, Document, IndexDescription } from "mongodb";
import { COLLECTIONS } from "../collections.js";
import { ALLERGENS, DIETARY_TAGS } from "../../domain/schemas.js";

export const id = "001_initial_schema";

const tenantId = { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" };
const date = { bsonType: "date" };
const intMin0 = { bsonType: ["int", "long"], minimum: 0 };

/**
 * Database-level validation is the second line of defence: even a bug or a script that bypasses the
 * application layer cannot write a document without a valid tenant id, or a float price.
 */
const validators: Record<string, Document> = {
  [COLLECTIONS.restaurants]: {
    bsonType: "object",
    required: ["restaurantId", "slug", "name", "status", "timezone", "currency", "createdAt", "updatedAt"],
    properties: { restaurantId: tenantId, status: { enum: ["active", "suspended"] }, createdAt: date, updatedAt: date },
  },
  [COLLECTIONS.widgetKeys]: {
    bsonType: "object",
    required: ["restaurantId", "publicKey", "allowedOrigins", "status", "createdAt"],
    properties: {
      restaurantId: tenantId,
      publicKey: { bsonType: "string", pattern: "^wk_[A-Za-z0-9_-]{32}$" },
      allowedOrigins: { bsonType: "array", minItems: 1, maxItems: 20, items: { bsonType: "string" } },
      status: { enum: ["active", "revoked"] },
    },
  },
  [COLLECTIONS.menuItems]: {
    bsonType: "object",
    required: ["restaurantId", "slug", "name", "nameNormalized", "category", "priceCents", "currency", "status",
      "available", "allergens", "allergensVerified", "dietaryTags", "createdAt", "updatedAt"],
    properties: {
      restaurantId: tenantId,
      priceCents: { bsonType: ["int", "long"], minimum: 0, maximum: 10_000_000 },
      currency: { bsonType: "string", pattern: "^[A-Z]{3}$" },
      status: { enum: ["active", "archived"] },
      available: { bsonType: "bool" },
      allergens: { bsonType: "array", uniqueItems: true, items: { enum: [...ALLERGENS] } },
      dietaryTags: { bsonType: "array", uniqueItems: true, items: { enum: [...DIETARY_TAGS] } },
      allergensVerified: { bsonType: "bool" },
    },
  },
  [COLLECTIONS.openingHours]: {
    bsonType: "object",
    required: ["restaurantId", "weekly", "exceptions", "updatedAt"],
    properties: { restaurantId: tenantId, weekly: { bsonType: "array" }, exceptions: { bsonType: "array" } },
  },
  [COLLECTIONS.conversations]: {
    bsonType: "object",
    required: ["restaurantId", "sessionTokenHash", "status", "messageCount", "createdAt", "lastActivityAt", "expiresAt"],
    properties: {
      restaurantId: tenantId,
      sessionTokenHash: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
      status: { enum: ["active", "handoff", "closed"] },
      messageCount: intMin0,
      expiresAt: date,
    },
  },
  [COLLECTIONS.messages]: {
    bsonType: "object",
    required: ["restaurantId", "conversationId", "role", "content", "createdAt", "expiresAt"],
    properties: {
      restaurantId: tenantId,
      conversationId: { bsonType: "objectId" },
      role: { enum: ["user", "assistant", "tool"] },
      content: { bsonType: "string", minLength: 1, maxLength: 4000 },
      expiresAt: date,
    },
  },
  [COLLECTIONS.usageLogs]: {
    bsonType: "object",
    required: ["restaurantId", "conversationId", "model", "inputTokens", "outputTokens", "estimatedCostMicros", "createdAt", "expiresAt"],
    properties: {
      restaurantId: tenantId,
      conversationId: { bsonType: "objectId" },
      inputTokens: intMin0,
      outputTokens: intMin0,
      estimatedCostMicros: intMin0,
      expiresAt: date,
    },
  },
};

/**
 * Every index on a tenant-owned collection starts with restaurantId, so tenant-scoped queries are
 * served from a single tenant's slice of the index. The only exception is `widgetKeys.publicKey`:
 * resolving a widget key is the step that DISCOVERS the tenant, so it cannot be tenant-prefixed.
 */
const indexes: Record<string, IndexDescription[]> = {
  [COLLECTIONS.restaurants]: [
    { key: { restaurantId: 1 }, unique: true, name: "restaurantId_unique" },
    { key: { slug: 1 }, unique: true, name: "slug_unique" },
  ],
  [COLLECTIONS.widgetKeys]: [
    { key: { publicKey: 1 }, unique: true, name: "publicKey_unique" },
    { key: { restaurantId: 1, status: 1 }, name: "restaurantId_1_status_1" },
  ],
  [COLLECTIONS.menuItems]: [
    { key: { restaurantId: 1, slug: 1 }, unique: true, name: "restaurantId_1_slug_1" },
    { key: { restaurantId: 1, nameNormalized: 1 }, name: "restaurantId_1_nameNormalized_1" },
    { key: { restaurantId: 1, status: 1, category: 1 }, name: "restaurantId_1_status_1_category_1" },
  ],
  [COLLECTIONS.openingHours]: [{ key: { restaurantId: 1 }, unique: true, name: "restaurantId_unique" }],
  [COLLECTIONS.conversations]: [
    { key: { restaurantId: 1, sessionTokenHash: 1 }, unique: true, name: "restaurantId_1_sessionTokenHash_1" },
    { key: { restaurantId: 1, createdAt: -1 }, name: "restaurantId_1_createdAt_-1" },
    { key: { restaurantId: 1, status: 1 }, name: "restaurantId_1_status_1" },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "ttl_expiresAt" },
  ],
  [COLLECTIONS.messages]: [
    { key: { restaurantId: 1, conversationId: 1, createdAt: 1 }, name: "restaurantId_1_conversationId_1_createdAt_1" },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "ttl_expiresAt" },
  ],
  [COLLECTIONS.usageLogs]: [
    { key: { restaurantId: 1, createdAt: -1 }, name: "restaurantId_1_createdAt_-1" },
    { key: { restaurantId: 1, conversationId: 1 }, name: "restaurantId_1_conversationId_1" },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "ttl_expiresAt" },
  ],
};

export async function up(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, schema] of Object.entries(validators)) {
    const validation = { validator: { $jsonSchema: schema }, validationLevel: "strict", validationAction: "error" } as const;
    if (existing.has(name)) await db.command({ collMod: name, ...validation });
    else await db.createCollection(name, validation);
  }
  for (const [name, specs] of Object.entries(indexes)) {
    await db.collection(name).createIndexes(specs);
  }
}
