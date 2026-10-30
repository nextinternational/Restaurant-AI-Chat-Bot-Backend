import { parseArgs } from "node:util";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { getCollections } from "../db/collections.js";
import { runMigrations } from "../db/migrate.js";
import { MongoAccountStore } from "../repositories/accountStore.js";
import { ProvisioningService } from "../services/provisioningService.js";
import { AppError } from "../errors.js";

const USAGE = `Usage:
  npm run provision:restaurant -- --name "Harbor Grill" --timezone Asia/Dubai \\
      --owner-email owner@example.com --owner-name "Sam Owner" \\
      [--slug harbor-grill] [--currency AED] [--locale en] [--origin https://harborgrill.com]...
  npm run provision:settings -- --restaurant harbor-grill [--address "1 Beach Rd"] [--phone "+1 268 555 0100"] \\
      [--map-url https://maps.example/x] [--notes "Free parking"] \\
      [--monthly-ai-budget-usd 10]
  npm run provision:staff -- --restaurant harbor-grill --email chef@example.com --name "Chef" --role manager

Passwords are NEVER taken from the command line (shell history). Set PROVISION_PASSWORD to choose one;
otherwise a strong password is generated and printed once. An existing user (same email) is attached
to the restaurant and keeps their current password.
`;

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => {
  process.stderr.write(`${s}\n`);
  return process.exit(code);
};

const command = process.argv[2];
if (command !== "restaurant" && command !== "staff" && command !== "settings") fail(USAGE, 2);

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    name: { type: "string" }, slug: { type: "string" }, timezone: { type: "string" }, currency: { type: "string" },
    locale: { type: "string" }, origin: { type: "string", multiple: true },
    "owner-email": { type: "string" }, "owner-name": { type: "string" },
    restaurant: { type: "string" }, email: { type: "string" }, role: { type: "string" },
    address: { type: "string" }, phone: { type: "string" }, "map-url": { type: "string" }, notes: { type: "string" },
    "monthly-ai-budget-usd": { type: "string" },
  },
  strict: true,
});

const env = loadEnv();
const database = await connectMongo(env);
try {
  await runMigrations(database.db);
  const logger = pino({ level: env.LOG_LEVEL });
  const store = new MongoAccountStore(getCollections(database.db));
  const service = new ProvisioningService(store, { allowInsecureLocalhostOrigins: env.NODE_ENV !== "production" }, logger);
  const password = process.env.PROVISION_PASSWORD || undefined;

  if (command === "restaurant") {
    const r = await service.provisionRestaurant({
      name: values.name ?? "", timezone: values.timezone ?? "",
      ownerEmail: values["owner-email"] ?? "", ownerName: values["owner-name"] ?? "",
      ...(values.slug ? { slug: values.slug } : {}), ...(values.currency ? { currency: values.currency } : {}),
      ...(values.locale ? { locale: values.locale } : {}), ...(values.origin ? { origins: values.origin } : {}),
      ...(password ? { ownerPassword: password } : {}),
    });
    out(`restaurant: ${r.restaurantId} (slug: ${r.slug})`);
    out(`owner:      ${r.owner.email} (${r.owner.created ? "created" : "existing user attached, password unchanged"})`);
    if (r.owner.generatedPassword) out(`password:   ${r.owner.generatedPassword}   <- shown once, store it now`);
    for (const k of r.widgetKeys) out(`widget key: ${k.publicKey}  origins: ${k.allowedOrigins.join(", ")}`);
  } else if (command === "settings") {
    const r = await service.updateSettings({
      restaurantSlug: values.restaurant ?? "",
      ...(values.address ? { address: values.address } : {}), ...(values.phone ? { phone: values.phone } : {}),
      ...(values["map-url"] ? { mapUrl: values["map-url"] } : {}), ...(values.notes ? { notes: values.notes } : {}),
      ...(values["monthly-ai-budget-usd"] ? { monthlyAiBudgetUsd: Number(values["monthly-ai-budget-usd"]) } : {}),
    });
    out(`settings updated for ${r.restaurantId}: ${r.changed.join(", ")}`);
  } else {
    const r = await service.addStaff({
      restaurantSlug: values.restaurant ?? "", email: values.email ?? "", name: values.name ?? "",
      ...(values.role ? { role: values.role as never } : {}), ...(password ? { password } : {}),
    });
    out(`staff:      ${r.user.email} -> ${r.restaurantId} as ${r.role} (${r.user.created ? "created" : "existing user attached"})`);
    if (r.user.generatedPassword) out(`password:   ${r.user.generatedPassword}   <- shown once, store it now`);
  }
} catch (err) {
  if (err instanceof AppError) fail(`error: ${err.message}`);
  throw err;
} finally {
  await database.close();
}
