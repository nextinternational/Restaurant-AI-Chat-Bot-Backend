import type { Db, IndexDescription } from "mongodb";
import { COLLECTIONS } from "../collections.js";

export async function up(db: Db): Promise<void> {
  const schemas: Record<string, object> = {
    [COLLECTIONS.users]: {
      bsonType: "object",
      required: ["userId", "email", "name", "passwordHash", "status", "createdAt", "updatedAt"],
      properties: {
        userId: { bsonType: "string", pattern: "^usr_[a-z0-9_-]{8,40}$" },
        email: { bsonType: "string", maxLength: 320 },
        name: { bsonType: "string", minLength: 1, maxLength: 120 },
        passwordHash: { bsonType: "string", maxLength: 200 },
        status: { enum: ["active", "suspended", "pending"] },
      },
    },
    [COLLECTIONS.memberships]: {
      bsonType: "object",
      required: ["userId", "restaurantId", "role", "status", "createdAt", "updatedAt"],
      properties: {
        userId: { bsonType: "string", pattern: "^usr_[a-z0-9_-]{8,40}$" },
        restaurantId: { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" },
        role: { enum: ["owner", "admin", "manager", "staff", "viewer"] },
        status: { enum: ["active", "invited", "suspended"] },
      },
    },
    [COLLECTIONS.sessions]: {
      bsonType: "object",
      required: ["userId", "tokenHash", "createdAt", "lastSeenAt", "expiresAt"],
      properties: {
        userId: { bsonType: "string", pattern: "^usr_[a-z0-9_-]{8,40}$" },
        tokenHash: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
        expiresAt: { bsonType: "date" },
      },
    },
    [COLLECTIONS.plans]: {
      bsonType: "object",
      required: ["code", "name", "monthlyPriceCents", "currency", "monthlyMessageLimit", "monthlyAiBudgetMicros", "features", "active", "createdAt", "updatedAt"],
      properties: {
        code: { bsonType: "string", pattern: "^[a-z0-9-]+$" },
        monthlyPriceCents: { bsonType: "int", minimum: 0 },
        monthlyMessageLimit: { bsonType: "int", minimum: 0 },
        monthlyAiBudgetMicros: { bsonType: "long", minimum: 0 },
        active: { bsonType: "bool" },
      },
    },
    [COLLECTIONS.subscriptions]: {
      bsonType: "object",
      required: ["restaurantId", "planCode", "status", "currentPeriodStart", "currentPeriodEnd", "provider", "createdAt", "updatedAt"],
      properties: {
        restaurantId: { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" },
        planCode: { bsonType: "string" },
        status: { enum: ["trialing", "active", "past_due", "canceled", "paused"] },
        provider: { enum: ["manual", "stripe"] },
      },
    },
    [COLLECTIONS.apiKeys]: {
      bsonType: "object",
      required: ["restaurantId", "name", "keyPrefix", "keyHash", "status", "createdAt"],
      properties: {
        restaurantId: { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" },
        keyPrefix: { bsonType: "string", pattern: "^rk_[A-Za-z0-9_-]{8}$" },
        keyHash: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
        status: { enum: ["active", "revoked"] },
      },
    },
    [COLLECTIONS.auditLogs]: {
      bsonType: "object",
      required: ["restaurantId", "action", "resourceType", "metadata", "createdAt"],
      properties: {
        restaurantId: { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" },
        actorUserId: { bsonType: "string", pattern: "^usr_[a-z0-9_-]{8,40}$" },
        action: { bsonType: "string", maxLength: 120 },
        resourceType: { bsonType: "string", maxLength: 80 },
        metadata: { bsonType: "object" },
      },
    },
  };

  for (const [name, validator] of Object.entries(schemas)) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    const validation = { validator: { $jsonSchema: validator }, validationLevel: "strict", validationAction: "error" };
    if (exists) await db.command({ collMod: name, ...validation });
    else await db.createCollection(name, validation);
  }

  const indexes: Record<string, IndexDescription[]> = {
    [COLLECTIONS.users]: [
      { key: { userId: 1 }, unique: true, name: "userId_unique" },
      { key: { email: 1 }, unique: true, name: "email_unique" },
    ],
    [COLLECTIONS.memberships]: [
      { key: { userId: 1, restaurantId: 1 }, unique: true, name: "user_restaurant_unique" },
      { key: { restaurantId: 1, status: 1 }, name: "restaurantId_1_status_1" },
    ],
    [COLLECTIONS.sessions]: [
      { key: { tokenHash: 1 }, unique: true, name: "tokenHash_unique" },
      { key: { userId: 1, createdAt: -1 }, name: "userId_1_createdAt_-1" },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "ttl_expiresAt" },
    ],
    [COLLECTIONS.plans]: [{ key: { code: 1 }, unique: true, name: "code_unique" }],
    [COLLECTIONS.subscriptions]: [
      { key: { restaurantId: 1 }, unique: true, name: "restaurantId_unique" },
      { key: { providerSubscriptionId: 1 }, sparse: true, unique: true, name: "providerSubscriptionId_unique" },
    ],
    [COLLECTIONS.apiKeys]: [
      { key: { keyHash: 1 }, unique: true, name: "keyHash_unique" },
      { key: { restaurantId: 1, status: 1 }, name: "restaurantId_1_status_1" },
    ],
    [COLLECTIONS.auditLogs]: [{ key: { restaurantId: 1, createdAt: -1 }, name: "restaurantId_1_createdAt_-1" }],
  };
  for (const [name, specs] of Object.entries(indexes)) await db.collection(name).createIndexes(specs);
}
