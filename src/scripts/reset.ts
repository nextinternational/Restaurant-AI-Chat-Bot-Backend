import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { runMigrations } from "../db/migrate.js";

/**
 * DESTRUCTIVE: drops the whole configured database (every restaurant, user, menu, conversation, ...)
 * and recreates the empty schema. Development only; requires --yes.
 *   npm run db:reset -- --yes
 */
const env = loadEnv();
if (env.NODE_ENV === "production") {
  process.stderr.write("Refusing to reset the database in production.\n");
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  process.stderr.write(
    `This will DELETE ALL DATA in database "${env.MONGODB_DB_NAME}".\nRe-run with --yes to confirm:  npm run db:reset -- --yes\n`,
  );
  process.exit(1);
}

const database = await connectMongo(env);
try {
  await database.db.dropDatabase();
  process.stdout.write(`dropped database "${env.MONGODB_DB_NAME}"\n`);
  await runMigrations(database.db, (m) => process.stdout.write(`${m}\n`));
  process.stdout.write("empty schema recreated. Next: npm run provision:restaurant -- ...\n");
} finally {
  await database.close();
}