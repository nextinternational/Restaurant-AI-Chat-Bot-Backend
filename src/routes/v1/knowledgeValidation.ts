import { z } from "zod";
import { FAQ_STATUSES, POLICY_KINDS, type PolicyKind } from "../../domain/schemas.js";
import { isSlug } from "./catalogValidation.js";

export const isPolicyKind = (v: unknown): v is PolicyKind => typeof v === "string" && (POLICY_KINDS as readonly string[]).includes(v);

const slug = z.string().max(80).refine(isSlug, "invalid slug");
const question = z.string().trim().min(3).max(300);
const answer = z.string().trim().min(1).max(2000);
const category = z.string().trim().min(1).max(60);
const keywords = z.array(z.string().trim().min(1).max(40)).max(20);

export const createFaqBody = z.strictObject({
  question,
  answer,
  slug: slug.optional(),
  category: category.optional(),
  keywords: keywords.default([]),
});

export const updateFaqBody = z
  .strictObject({
    question: question.optional(),
    answer: answer.optional(),
    category: category.nullable().optional(),
    keywords: keywords.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "at least one field is required");

export const listFaqsQuery = z.object({
  /** `live` = drafts and published (the default); archived entries are shown only when asked for. */
  status: z.enum([...FAQ_STATUSES, "live", "all"]).default("live"),
  category: category.optional(),
  after: slug.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const policyBody = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  body: answer,
});
