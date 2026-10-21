import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();
const database = await connectMongo(env);
try {
  const ran = await runMigrations(database.db, (m) => process.stdout.write(`${m}\n`));
  process.stdout.write(ran.length ? `applied ${ran.length} migration(s)\n` : "database already up to date\n");
} finally {
  await database.close();
}
