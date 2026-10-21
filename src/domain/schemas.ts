import { z } from "zod";
import type { ObjectId } from "mongodb";
import { restaurantIdSchema } from "./ids.js";

/** The 14 allergens that EU Regulation 1169/2011 requires restaurants to declare. */
export const ALLERGENS = [
  "celery", "cereals_gluten", "crustaceans", "eggs", "fish", "lupin", "milk",
  "molluscs", "mustard", "tree_nuts", "peanuts", "sesame", "soybeans", "sulphites",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const DIETARY_TAGS = ["vegetarian", "vegan", "halal", "kosher", "gluten_free", "dairy_free"] as const;

const money = z.number().int().min(0).max(10_000_000); // integer minor units, never floats
const currency = z.string().regex(/^[A-Z]{3}$/); // ISO 4217
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Linear-time slug check (a nested-quantifier regex here would be a ReDoS risk).
const slug = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[a-z0-9-]+$/)
    .refine((v) => !v.startsWith("-") && !v.endsWith("-") && !v.includes("--"), "invalid slug");
const locale = z.string().regex(/^[a-z]{2}$|^[a-z]{2}-[A-Z]{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const timezone = z.string().refine(isValidTimeZone, "invalid IANA timezone");

// ---------------------------------------------------------------- restaurants
export const restaurantSchema = z.object({
  restaurantId: restaurantIdSchema,
  slug: slug(64),
  name: text(120),
  status: z.enum(["active", "suspended"]),
  timezone,
  currency,
  defaultLocale: locale.default("en"),
  /** Optional per-restaurant overrides of the platform-wide retention defaults. */
  retention: z
    .object({
      messagesDays: z.number().int().min(1).max(3650).optional(),
      conversationsDays: z.number().int().min(1).max(3650).optional(),
      usageMonths: z.number().int().min(1).max(120).optional(),
    })
    .default({}),
  /** Hard AI spend ceiling per calendar month, in micro-USD (1e-6 USD). 0 = use AI_DEFAULT_MONTHLY_BUDGET_MICROS. */
  monthlyAiBudgetMicros: z.number().int().min(0).default(0),
  /**
   * Public facts about the restaurant. The assistant reads address/map/notes through the get_location tool.
   * `phone` is the number customers are given whenever the assistant cannot help; only code states it, never the model.
   */
  location: z
    .object({
      address: text(300),
      phone: z.string().trim().max(40).optional(),
      mapUrl: z.string().url().max(300).optional(),
      notes: z.string().trim().max(300).optional(),
    })
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Restaurant = z.infer<typeof restaurantSchema>;

// ---------------------------------------------------------------- widget keys
/** A widget key IDENTIFIES a widget. It is public (it ships in page HTML) and is NOT authentication. */
export const widgetKeySchema = z.object({
  restaurantId: restaurantIdSchema,
  publicKey: z.string().regex(/^wk_[A-Za-z0-9_-]{32}$/),
  /** Exact origins (scheme + host + port) the widget may be embedded on, e.g. https://example.com */
  allowedOrigins: z.array(z.string().url().max(200)).min(1).max(20),
  status: z.enum(["active", "revoked"]),
  label: text(80).optional(),
  createdAt: z.date(),
  revokedAt: z.date().optional(),
});
export type WidgetKey = z.infer<typeof widgetKeySchema>;

// ---------------------------------------------------------------- menu items
export const menuItemSchema = z
  .object({
    restaurantId: restaurantIdSchema,
    slug: slug(80),
    name: text(120),
    /** Lower-cased, accent-stripped name used for lookups from natural language. */
    nameNormalized: text(120),
    description: z.string().trim().max(1000).optional(),
    category: text(60),
    priceCents: money,
    currency,
    status: z.enum(["active", "archived"]),
    available: z.boolean(),
    dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length),
    /**
     * Allergen data is only usable when a human has verified it. "No allergens listed" and
     * "allergen data not verified" are different facts; the model is never allowed to treat the first
     * as the second (see `toAllergenView`).
     */
    allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length),
    allergensVerified: z.boolean(),
    allergensVerifiedAt: z.date().optional(),
    allergensVerifiedBy: text(120).optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((m) => !m.allergensVerified || (m.allergensVerifiedAt && m.allergensVerifiedBy), {
    message: "verified allergen data requires allergensVerifiedAt and allergensVerifiedBy",
    path: ["allergensVerified"],
  });
export type MenuItem = z.infer<typeof menuItemSchema>;

export type AllergenView =
  | { verified: true; allergens: readonly Allergen[] }
  | { verified: false };

/** The ONLY way tool code should read allergens: unverified data is never exposed at all. */
export function toAllergenView(item: Pick<MenuItem, "allergens" | "allergensVerified">): AllergenView {
  return item.allergensVerified ? { verified: true, allergens: item.allergens } : { verified: false };
}

// ---------------------------------------------------------------- opening hours
const period = z
  .object({ opens: hhmm, closes: hhmm })
  .refine((p) => p.opens !== p.closes, "opens and closes must differ");
// If closes <= opens the period runs past midnight into the next day.
export const openingHoursSchema = z.object({
  restaurantId: restaurantIdSchema,
  /** Index 0 = Sunday ... 6 = Saturday. Missing / empty day = closed. */
  weekly: z
    .array(z.object({ day: z.number().int().min(0).max(6), periods: z.array(period).max(4) }))
    .max(7)
    .refine((w) => new Set(w.map((d) => d.day)).size === w.length, "duplicate day"),
  /** Holidays and special days. They override the weekly schedule for that date. */
  exceptions: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        closed: z.boolean(),
        periods: z.array(period).max(4),
        note: z.string().max(200).optional(),
      }),
    )
    .max(400),
  updatedAt: z.date(),
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

// ---------------------------------------------------------------- knowledge base: FAQs and policies
/**
 * Policies are a closed set of kinds, one document per kind per restaurant. A fixed vocabulary means the assistant
 * looks a policy up by key (no guessing, no fuzzy matching on liability-relevant text). Anything else is an FAQ.
 */
export const POLICY_KINDS = [
  "cancellation", "refund", "dress_code", "children", "pets", "payment", "delivery",
  "takeaway", "corkage", "parking", "accessibility", "private_events", "service_charge",
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const FAQ_MAX_PER_RESTAURANT = 100; // live (draft + published) entries; keeps retrieval bounded
export const FAQ_STATUSES = ["draft", "published", "archived"] as const;
export const POLICY_STATUSES = ["draft", "published"] as const;

/**
 * Only `published` content is ever visible to the assistant. Drafts and archived entries exist for staff only,
 * the same way unverified allergen data is invisible to the model.
 */
export const faqSchema = z
  .object({
    restaurantId: restaurantIdSchema,
    slug: slug(80),
    question: text(300),
    answer: text(2000),
    category: text(60).optional(),
    /** Synonyms staff add so the right entry is found ("kids", "children", "baby"). */
    keywords: z.array(text(40)).max(20),
    status: z.enum(FAQ_STATUSES),
    publishedAt: z.date().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((f) => f.status !== "published" || f.publishedAt !== undefined, {
    message: "a published FAQ requires publishedAt",
    path: ["publishedAt"],
  });
export type Faq = z.infer<typeof faqSchema>;

export const policySchema = z
  .object({
    restaurantId: restaurantIdSchema,
    kind: z.enum(POLICY_KINDS),
    title: text(120),
    body: text(2000),
    status: z.enum(POLICY_STATUSES),
    publishedAt: z.date().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((p) => p.status !== "published" || p.publishedAt !== undefined, {
    message: "a published policy requires publishedAt",
    path: ["publishedAt"],
  });
export type Policy = z.infer<typeof policySchema>;

// ---------------------------------------------------------------- conversations & messages
export const MAX_MESSAGE_CHARS = 4000;

export const conversationSchema = z.object({
  restaurantId: restaurantIdSchema,
  /** SHA-256 of the random session token. The token itself is never stored. */
  sessionTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  widgetKeyId: z.string().optional(),
  /** "handoff" is a legacy value from earlier versions; new conversations are only ever active or closed. */
  status: z.enum(["active", "handoff", "closed"]),
  /** Rolling summary used instead of replaying the full history to the model (spec section 7). */
  summary: z.string().max(4000).optional(),
  messageCount: z.number().int().min(0),
  createdAt: z.date(),
  lastActivityAt: z.date(),
  /** TTL anchor: Mongo deletes the document at this instant (see retention policy). */
  expiresAt: z.date(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  restaurantId: restaurantIdSchema,
  conversationId: z.custom<ObjectId>((v) => typeof v === "object" && v !== null && "toHexString" in v),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(MAX_MESSAGE_CHARS),
  toolName: z.string().max(64).optional(),
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type Message = z.infer<typeof messageSchema>;

// ---------------------------------------------------------------- usage logs
/**
 * Cost is stored in integer micro-USD (1e-6 USD) rather than a float such as 0.012: the platform
 * applies the same "no floating-point money" rule to its own billing data that it applies to menu prices.
 */
export const usageLogSchema = z.object({
  restaurantId: restaurantIdSchema,
  conversationId: z.custom<ObjectId>((v) => typeof v === "object" && v !== null && "toHexString" in v),
  model: text(80),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCostMicros: z.number().int().min(0),
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type UsageLog = z.infer<typeof usageLogSchema>;


// ---------------------------------------------------------------- SaaS identity, billing & governance
const prefixedId = (prefix: "usr_", max = 40) =>
  z
    .string()
    .max(prefix.length + max)
    .refine((v) => v.startsWith(prefix) && /^[a-z0-9_-]{8,40}$/.test(v.slice(prefix.length)), "invalid id");

export const userSchema = z.object({
  userId: prefixedId("usr_"),
  email: z.string().email().max(320).transform((v) => v.toLowerCase()),
  name: text(120),
  passwordHash: text(200),
  status: z.enum(["active", "suspended", "pending"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type User = z.infer<typeof userSchema>;

export const membershipSchema = z.object({
  userId: prefixedId("usr_"),
  restaurantId: restaurantIdSchema,
  role: z.enum(["owner", "admin", "manager", "staff", "viewer"]),
  status: z.enum(["active", "invited", "suspended"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const sessionSchema = z.object({
  userId: prefixedId("usr_"),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.date(),
  lastSeenAt: z.date(),
  expiresAt: z.date(),
  revokedAt: z.date().optional(),
});
export type UserSession = z.infer<typeof sessionSchema>;

export const planSchema = z.object({
  code: slug(40),
  name: text(80),
  monthlyPriceCents: money,
  currency,
  monthlyMessageLimit: z.number().int().min(0),
  monthlyAiBudgetMicros: z.number().int().min(0),
  features: z.array(text(80)).max(100),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Plan = z.infer<typeof planSchema>;

export const subscriptionSchema = z.object({
  restaurantId: restaurantIdSchema,
  planCode: slug(40),
  status: z.enum(["trialing", "active", "past_due", "canceled", "paused"]),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  provider: z.enum(["manual", "stripe"]),
  providerCustomerId: z.string().max(200).optional(),
  providerSubscriptionId: z.string().max(200).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const apiKeySchema = z.object({
  restaurantId: restaurantIdSchema,
  name: text(80),
  keyPrefix: z.string().regex(/^rk_[A-Za-z0-9_-]{8}$/),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["active", "revoked"]),
  createdAt: z.date(),
  lastUsedAt: z.date().optional(),
  expiresAt: z.date().optional(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const auditLogSchema = z.object({
  restaurantId: restaurantIdSchema,
  actorUserId: prefixedId("usr_").optional(),
  action: text(120),
  resourceType: text(80),
  resourceId: text(120).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.date(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;
