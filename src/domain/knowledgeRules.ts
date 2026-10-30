import { normalizeName } from "../repositories/normalize.js"; // pure helper, no I/O
import { faqSchema, type Faq, type PolicyKind } from "./schemas.js";

/**
 * Pure rules for the FAQ / policy knowledge base. No I/O, so the repository, the service, the AI tools and the
 * in-memory test doubles all share ONE implementation of retrieval and patching.
 */

const LABELS: readonly (readonly [PolicyKind, string])[] = [
  ["cancellation", "Cancellation policy"],
  ["refund", "Refund policy"],
  ["dress_code", "Dress code"],
  ["children", "Children policy"],
  ["pets", "Pets policy"],
  ["payment", "Payment methods"],
  ["delivery", "Delivery policy"],
  ["takeaway", "Takeaway policy"],
  ["corkage", "Corkage policy"],
  ["parking", "Parking"],
  ["accessibility", "Accessibility"],
  ["private_events", "Private events"],
  ["service_charge", "Service charge and gratuity"],
];

/** Default title for a policy when staff do not give one. */
export const POLICY_LABELS: ReadonlyMap<PolicyKind, string> = new Map(LABELS);

// ------------------------------------------------------------------------------------------------ retrieval
const STOPWORDS = new Set([
  "the", "an", "is", "are", "do", "does", "you", "your", "we", "our", "can", "my", "to", "of", "and", "or", "for", "in", "on",
  "at", "it", "be", "have", "has", "what", "how", "when", "where", "which", "there", "any", "about", "with", "me", "us",
  "please", "if", "this", "that", "am", "was", "will", "would", "could", "may", "get", "tell", "know", "also", "too",
  "في", "من", "على", "هل", "ما", "ماذا", "كيف", "متى", "أين", "اين", "عن", "الى", "إلى", "هذا", "هذه", "لدي", "لديكم", "عندكم", "هي", "هو", "او", "أو", "مع",
]);

/** Cheap, dependency-free normalisation: lower-case, strip accents/diacritics, drop a trailing plural "s" and the Arabic article. */
function stem(token: string): string {
  if (/^[a-z]+$/.test(token)) return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
  if (token.startsWith("ال") && token.length > 4) return token.slice(2);
  return token;
}

export function searchTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of normalizeName(text).split(" ")) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return [...out];
}

type Searchable = Pick<Faq, "question" | "answer" | "keywords" | "slug">;

export interface RankedFaq<T extends Searchable> {
  faq: T;
  score: number;
}

/**
 * Deterministic lexical ranking of published FAQs for a customer query.
 *
 * Weights: a query word in the question counts 3, in a staff keyword 2, in the answer 1. At least one word must hit
 * the question or a keyword, and at least half of the query's words must be found somewhere. Anything weaker is NOT
 * returned: a wrong FAQ is worse than none, because the right fallback for "no match" is the restaurant's phone number.
 * Entries scoring under half of the best one are dropped so the model is not handed noise.
 */
export function rankFaqs<T extends Searchable>(query: string, faqs: readonly T[], limit = 3): RankedFaq<T>[] {
  const q = searchTokens(query);
  if (q.length === 0) return [];
  const phrase = normalizeName(query);

  const scored: RankedFaq<T>[] = [];
  for (const faq of faqs) {
    const inQuestion = new Set(searchTokens(faq.question));
    const inKeywords = new Set(faq.keywords.flatMap((k) => searchTokens(k)));
    const inAnswer = new Set(searchTokens(faq.answer));

    let score = 0;
    let strong = 0;
    let anywhere = 0;
    for (const t of q) {
      const inQ = inQuestion.has(t);
      const inK = inKeywords.has(t);
      const inA = inAnswer.has(t);
      if (inQ) score += 3;
      if (inK) score += 2;
      if (inA) score += 1;
      if (inQ || inK) strong += 1;
      if (inQ || inK || inA) anywhere += 1;
    }
    if (strong === 0 || anywhere / q.length < 0.5) continue;
    // An exact-ish phrase match is the strongest signal there is.
    const normalizedQuestion = normalizeName(faq.question);
    if (phrase.length >= 4 && (normalizedQuestion.includes(phrase) || phrase.includes(normalizedQuestion))) score += 4;
    scored.push({ faq, score });
  }

  scored.sort((a, b) => b.score - a.score || a.faq.slug.localeCompare(b.faq.slug));
  const best = scored[0]?.score ?? 0;
  return scored.filter((s) => s.score * 2 >= best).slice(0, Math.max(1, limit));
}

// ------------------------------------------------------------------------------------------------ patching
export interface FaqPatch {
  question?: string;
  answer?: string;
  /** `null` removes the category. */
  category?: string | null;
  keywords?: string[];
}

export interface FaqPatchPlan {
  next: Faq;
  set: Record<string, unknown>;
  unset: string[];
  /** Public field names that changed (for the audit trail). Empty = the patch was a no-op. */
  changed: string[];
}

/** Case-insensitive de-duplication that keeps the first spelling and the staff's order. */
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim();
    const key = normalizeName(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** Applies a partial update, then re-validates the WHOLE document against the domain schema. Status never changes here. */
export function planFaqPatch(current: Faq, patch: FaqPatch, now: Date): FaqPatchPlan {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const changed: string[] = [];
  const next: Record<string, unknown> = { ...current };

  if (patch.question !== undefined && patch.question.trim() !== current.question) {
    next.question = patch.question.trim();
    set.question = next.question;
    changed.push("question");
  }
  if (patch.answer !== undefined && patch.answer.trim() !== current.answer) {
    next.answer = patch.answer.trim();
    set.answer = next.answer;
    changed.push("answer");
  }
  if (patch.category !== undefined) {
    const wanted = patch.category === null ? undefined : patch.category.trim();
    if (wanted !== current.category) {
      changed.push("category");
      if (wanted === undefined) {
        delete next.category;
        unset.push("category");
      } else {
        next.category = wanted;
        set.category = wanted;
      }
    }
  }
  if (patch.keywords !== undefined) {
    const keywords = normalizeKeywords(patch.keywords);
    if (JSON.stringify(keywords) !== JSON.stringify(current.keywords)) {
      next.keywords = keywords;
      set.keywords = keywords;
      changed.push("keywords");
    }
  }

  if (changed.length === 0) return { next: current, set: {}, unset: [], changed: [] };
  next.updatedAt = now;
  set.updatedAt = now;
  return { next: faqSchema.parse(next), set, unset, changed };
}
