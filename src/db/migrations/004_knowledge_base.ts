import type { Db, Document, IndexDescription } from "mongodb";
import { COLLECTIONS } from "../collections.js";
import { FAQ_STATUSES, POLICY_KINDS, POLICY_STATUSES } from "../../domain/schemas.js";

/**
 * FAQ and policy knowledge base for the assistant.
 * Same rules as 001: strict validators as the second line of defence, every index starts with restaurantId.
 */
const tenantId = { bsonType: "string", pattern: "^rest_[a-z0-9]{1,32}$" };
const date = { bsonType: "date" };

const validators: Record<string, Document> = {
  [COLLECTIONS.faqs]: {
    bsonType: "object",
    required: ["restaurantId", "slug", "question", "answer", "keywords", "status", "createdAt", "updatedAt"],
    properties: {
      restaurantId: tenantId,
      slug: { bsonType: "string", pattern: "^[a-z0-9-]{1,80}$" },
      question: { bsonType: "string", minLength: 1, maxLength: 300 },
      answer: { bsonType: "string", minLength: 1, maxLength: 2000 },
      keywords: { bsonType: "array", maxItems: 20, items: { bsonType: "string", minLength: 1, maxLength: 40 } },
      status: { enum: [...FAQ_STATUSES] },
      publishedAt: date,
      createdAt: date,
      updatedAt: date,
    },
  },
  [COLLECTIONS.policies]: {
    bsonType: "object",
    required: ["restaurantId", "kind", "title", "body", "status", "createdAt", "updatedAt"],
    properties: {
      restaurantId: tenantId,
      kind: { enum: [...POLICY_KINDS] },
      title: { bsonType: "string", minLength: 1, maxLength: 120 },
      body: { bsonType: "string", minLength: 1, maxLength: 2000 },
      status: { enum: [...POLICY_STATUSES] },
      publishedAt: date,
      createdAt: date,
      updatedAt: date,
    },
  },
};

const indexes: Record<string, IndexDescription[]> = {
  [COLLECTIONS.faqs]: [
    { key: { restaurantId: 1, slug: 1 }, unique: true, name: "restaurantId_1_slug_1" },
    // Serves both the assistant (status = published) and the staff listing (status filter, cursor on slug).
    { key: { restaurantId: 1, status: 1, slug: 1 }, name: "restaurantId_1_status_1_slug_1" },
  ],
  // One policy per kind per restaurant.
  [COLLECTIONS.policies]: [{ key: { restaurantId: 1, kind: 1 }, unique: true, name: "restaurantId_1_kind_1" }],
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
