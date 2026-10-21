import type { Db } from "mongodb";
import { COLLECTIONS } from "./collections.js";
import * as m001 from "./migrations/001_initial_schema.js";
import * as m002 from "./migrations/002_saas_foundation.js";
import * as m003 from "./migrations/003_plans_and_account_flows.js";
import * as m004 from "./migrations/004_knowledge_base.js";

/** Ordered, append-only list. Never edit a migration that has shipped; add a new one. */
const MIGRATIONS: { id: string; up: (db: Db) => Promise<void> }[] = [
  { ...m001, id: "001_initial_schema" },
  { ...m002, id: "002_saas_foundation" },
  { ...m003, id: "003_plans_and_account_flows" },
  { ...m004, id: "004_knowledge_base" },
];

export const LATEST_MIGRATION = MIGRATIONS.at(-1)!.id;

/** Applies pending migrations once each. Run explicitly (`npm run db:migrate`) from the deploy pipeline. */
export async function runMigrations(db: Db, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const ledger = db.collection<{ _id: string; appliedAt: Date }>(COLLECTIONS.migrations);
  const applied = new Set((await ledger.find().toArray()).map((d) => d._id));
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    log(`applying ${migration.id}`);
    await migration.up(db);
    await ledger.insertOne({ _id: migration.id, appliedAt: new Date() });
    ran.push(migration.id);
  }
  return ran;
}

/** Used at boot: the API refuses to run against a database that has not been migrated. */
export async function assertSchemaCurrent(db: Db): Promise<void> {
  const ledger = db.collection<{ _id: string }>(COLLECTIONS.migrations);
  if (!(await ledger.findOne({ _id: LATEST_MIGRATION }))) {
    throw new Error(`Database schema is out of date (missing ${LATEST_MIGRATION}). Run: npm run db:migrate`);
  }
}
