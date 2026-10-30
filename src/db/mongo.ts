import { MongoClient, type Db } from "mongodb";
import type { Env } from "../config/env.js";

export interface Database {
  db: Db;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

export async function connectMongo(env: Pick<Env, "MONGODB_URI" | "MONGODB_DB_NAME">): Promise<Database> {
  const client = new MongoClient(env.MONGODB_URI, {
    appName: "restaurant-ai-platform",
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 20_000,
    minPoolSize: 2,
    maxIdleTimeMS: 60_000,
    connectTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true,
    // Durability: a write acknowledged to the app has been replicated to a majority of nodes.
    writeConcern: { w: "majority" },
    readConcern: { level: "majority" },
    // Reject driver-side JS-style operators smuggled through unvalidated input.
    ignoreUndefined: true,
    // Atlas enforces TLS via the mongodb+srv:// URI. Never disable certificate validation.
  });
  await client.connect();
  const db = client.db(env.MONGODB_DB_NAME);
  return {
    db,
    ping: async () => {
      await db.command({ ping: 1 });
    },
    close: () => client.close(),
  };
}
