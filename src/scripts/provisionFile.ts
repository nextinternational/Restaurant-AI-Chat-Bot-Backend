/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- operator-only CLI reading a local file the operator chose */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { connectMongo } from "../db/mongo.js";
import { getCollections } from "../db/collections.js";
import { runMigrations } from "../db/migrate.js";
import { MongoAccountStore } from "../repositories/accountStore.js";
import { createRepositories } from "../repositories/index.js";
import { ProvisioningService } from "../services/provisioningService.js";
import { ALLERGENS, DIETARY_TAGS, POLICY_KINDS } from "../domain/schemas.js";
import { slugify } from "../domain/slug.js";
import { AppError } from "../errors.js";

/**
 * Usage:  node --env-file=.env --import tsx src/scripts/provisionFile.ts data/restaurants/big-banana.json
 * Safe to run again: existing restaurants/FAQs/menu items are skipped, hours and policies are replaced.
 */

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string, code = 1): never => {
  process.stderr.write(`${s}\n`);
  return process.exit(code);
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, e.g. 09:30");
const period = z.strictObject({ opens: hhmm, closes: hhmm });
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const fileSchema = z.strictObject({
  name: z.string().min(1),
  slug: z.string().optional(),
  timezone: z.string().min(1),
  currency: z.string().default("USD"),
  locale: z.string().default("en"),
  owner: z.strictObject({ name: z.string().min(1), email: z.string().min(1) }),
  origins: z.array(z.string()).default([]),
  settings: z
    .strictObject({
      address: z.string().optional(),
      phone: z.string().optional(),
      mapUrl: z.string().optional(),
      notes: z.string().optional(),
      monthlyAiBudgetUsd: z.number().min(0).optional(),
    })
    .default({}),
  hours: z
    .strictObject(Object.fromEntries(DAYS.map((d) => [d, z.array(period).max(4).optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<z.ZodArray<typeof period>>>)
    .optional(),
  holidays: z
    .array(z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), closed: z.boolean().default(true), periods: z.array(period).max(4).default([]), note: z.string().max(200).optional() }))
    .default([]),
  policies: z.partialRecord(z.enum(POLICY_KINDS), z.strictObject({ title: z.string().min(1), body: z.string().min(1) })).default({}),
  faqs: z
    .array(z.strictObject({ slug: z.string().optional(), question: z.string().min(1), answer: z.string().min(1), category: z.string().optional(), keywords: z.array(z.string()).default([]) }))
    .default([]),
  menu: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        category: z.string().min(1),
        price: z.number().min(0),
        available: z.boolean().default(true),
        dietaryTags: z.array(z.enum(DIETARY_TAGS)).default([]),
        allergens: z.array(z.enum(ALLERGENS)).default([]),
      }),
    )
    .default([]),
  /** false (default): FAQs and policies are saved as drafts and the AI cannot see them. true: publish them. */
  publish: z.boolean().default(false),
});

/** Template placeholders like "" are treated as "not filled in". */
function dropBlank(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropBlank);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "").map(([k, x]) => [k, dropBlank(x)]));
  }
  return v;
}

const path = process.argv[2];
if (!path) fail("Usage: node --env-file=.env --import tsx src/scripts/provisionFile.ts <file.json>", 2);

let raw: unknown;
try {
  raw = JSON.parse(await readFile(path!, "utf8"));
} catch (e) {
  fail(`Cannot read/parse ${path}: ${(e as Error).message}`);
}
const parsed = fileSchema.safeParse(dropBlank(raw));
if (!parsed.success) {
  fail(`Problems in ${path}:\n` + parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(file)"}: ${i.message}`).join("\n"));
}
const cfg = parsed.data!;

const env = loadEnv();
const database = await connectMongo(env);
try {
  await runMigrations(database.db);
  const logger = pino({ level: env.LOG_LEVEL });
  const store = new MongoAccountStore(getCollections(database.db));
  const service = new ProvisioningService(store, { allowInsecureLocalhostOrigins: env.NODE_ENV !== "production" }, logger);
  const repos = createRepositories(database.db, env);
  const slug = cfg.slug ?? slugify(cfg.name);
  if (!slug) fail("slug is required when the name has no Latin letters");

  // 1) restaurant + owner + widget key
  let restaurant = await store.findRestaurantBySlug(slug);
  if (restaurant) {
    out(`restaurant "${slug}" already exists: skipping creation`);
  } else {
    const password = process.env.PROVISION_PASSWORD || undefined;
    const r = await service.provisionRestaurant({
      name: cfg.name, slug, timezone: cfg.timezone, currency: cfg.currency, locale: cfg.locale,
      ownerEmail: cfg.owner.email, ownerName: cfg.owner.name, origins: cfg.origins,
      ...(password ? { ownerPassword: password } : {}),
    });
    out(`restaurant: ${r.restaurantId} (slug: ${r.slug})`);
    out(`owner:      ${r.owner.email} (${r.owner.created ? "created" : "existing user attached, password unchanged"})`);
    if (r.owner.generatedPassword) out(`password:   ${r.owner.generatedPassword}   <- shown once, store it now`);
    for (const k of r.widgetKeys) out(`widget key: ${k.publicKey}  origins: ${k.allowedOrigins.join(", ")}`);
    restaurant = await store.findRestaurantBySlug(slug);
  }
  if (!restaurant) fail("restaurant not found after creation");
  const rest = restaurant!;

  // 2) settings (address, phone, map, notes, AI budget)
  const s = cfg.settings;
  if (s.address || s.phone || s.mapUrl || s.notes || s.monthlyAiBudgetUsd !== undefined) {
    const r = await service.updateSettings({
      restaurantSlug: slug,
      ...(s.address ? { address: s.address } : {}), ...(s.phone ? { phone: s.phone } : {}),
      ...(s.mapUrl ? { mapUrl: s.mapUrl } : {}), ...(s.notes ? { notes: s.notes } : {}),
      ...(s.monthlyAiBudgetUsd !== undefined ? { monthlyAiBudgetUsd: s.monthlyAiBudgetUsd } : {}),
    });
    out(`settings:   ${r.changed.join(", ")}`);
  }

  const t = repos.forTenant({ restaurantId: rest.restaurantId, retention: rest.retention });

  // 3) opening hours (a day with no periods is closed)
  if (cfg.hours) {
    const hours = cfg.hours;
    await t.hours.replace({
      weekly: DAYS.map((d, day) => ({ day, periods: hours[d] ?? [] })),
      exceptions: cfg.holidays,
    });
    out("hours:      saved");
  }

  // 4) policies
  for (const kind of POLICY_KINDS) {
    const p = cfg.policies[kind];
    if (!p) continue;
    await t.knowledge.savePolicy(kind, p);
    if (cfg.publish) await t.knowledge.setPolicyStatus(kind, "published");
    out(`policy:     ${kind} (${cfg.publish ? "published" : "draft"})`);
  }

  // 5) FAQs
  for (const f of cfg.faqs) {
    const fslug = (f.slug ?? slugify(f.question)).slice(0, 80).replace(/-+$/, "");
    if (!fslug) { out(`faq:        SKIPPED "${f.question.slice(0, 40)}" (add a "slug")`); continue; }
    try {
      await t.knowledge.createFaq({ slug: fslug, question: f.question, answer: f.answer, keywords: f.keywords, ...(f.category ? { category: f.category } : {}) });
      out(`faq:        ${fslug} (created)`);
    } catch (e) {
      if (e instanceof AppError && e.statusCode === 409) out(`faq:        ${fslug} (already exists, skipped)`);
      else throw e;
    }
    if (cfg.publish) await t.knowledge.setFaqStatus(fslug, "published");
  }

  // 6) menu. Allergens are ALWAYS saved as unverified: a human must verify them later.
  for (const m of cfg.menu) {
    const mslug = (m.slug ?? slugify(m.name)).slice(0, 80).replace(/-+$/, "");
    if (!mslug) { out(`menu:       SKIPPED "${m.name}" (add a "slug")`); continue; }
    try {
      await t.menu.create({
        slug: mslug, name: m.name, category: m.category, priceCents: Math.round(m.price * 100), currency: rest.currency,
        status: "active", available: m.available, dietaryTags: m.dietaryTags, allergens: m.allergens, allergensVerified: false,
        ...(m.description ? { description: m.description } : {}),
      });
      out(`menu:       ${mslug} (created)`);
    } catch (e) {
      if (e instanceof AppError && e.statusCode === 409) out(`menu:       ${mslug} (already exists, skipped)`);
      else throw e;
    }
  }
  out("done");
} catch (err) {
  if (err instanceof AppError) fail(`error: ${err.message}`);
  throw err;
} finally {
  await database.close();
}
