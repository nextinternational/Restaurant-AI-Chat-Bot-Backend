import { z } from "zod";
import { ALLERGENS, DIETARY_TAGS } from "../../domain/schemas.js";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)");
const period = z.strictObject({ opens: hhmm, closes: hhmm }).refine((p) => p.opens !== p.closes, "opens and closes must differ");

/** Same shape as the domain slug rule; checked with a linear-time test (no nested quantifiers). */
export const SLUG_PARAM = /^[a-z0-9-]{1,80}$/;
export const isSlug = (v: unknown): v is string =>
  typeof v === "string" && SLUG_PARAM.test(v) && !v.startsWith("-") && !v.endsWith("-") && !v.includes("--");

const slug = z.string().max(80).refine(isSlug, "invalid slug");
const name = z.string().trim().min(1).max(120);
const category = z.string().trim().min(1).max(60);
// Price is always integer minor units (cents). Floats are rejected, never rounded.
const priceCents = z.number().int().min(0).max(10_000_000);
const dietaryTags = z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length);

export const createItemBody = z.strictObject({
  name,
  slug: slug.optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  category,
  priceCents,
  available: z.boolean().default(true),
  dietaryTags: dietaryTags.default([]),
});

export const updateItemBody = z
  .strictObject({
    name: name.optional(),
    description: z.string().trim().min(1).max(1000).nullable().optional(),
    category: category.optional(),
    priceCents: priceCents.optional(),
    available: z.boolean().optional(),
    dietaryTags: dietaryTags.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "at least one field is required");

export const listItemsQuery = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
  category: category.optional(),
  after: slug.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * `confirmed: true` is a deliberate, explicit attestation that a person checked this declaration against the recipe.
 * An empty list is valid ("contains none of the 14 allergens") but is exactly the claim that hurts most when wrong,
 * so it needs the same attestation as any other list.
 */
export const verifyAllergensBody = z.strictObject({
  allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length),
  confirmed: z.literal(true, "must be true: confirm the declaration was checked against the recipe"),
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
export const hoursBody = z.strictObject({
  weekly: z.array(z.strictObject({ day: z.number().int().min(0).max(6), periods: z.array(period).max(4) })).max(7),
  exceptions: z
    .array(z.strictObject({ date, closed: z.boolean(), periods: z.array(period).max(4).default([]), note: z.string().trim().min(1).max(200).optional() }))
    .max(400)
    .default([]),
});
