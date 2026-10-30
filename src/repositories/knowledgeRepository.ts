import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import type { RestaurantId } from "../domain/ids.js";
import { normalizeKeywords, planFaqPatch, type FaqPatch } from "../domain/knowledgeRules.js";
import {
  FAQ_MAX_PER_RESTAURANT, faqSchema, policySchema, POLICY_KINDS,
  type Faq, type Policy, type PolicyKind,
} from "../domain/schemas.js";
import { AppError } from "../errors.js";

export type NewFaq = Pick<Faq, "slug" | "question" | "answer"> & Partial<Pick<Faq, "category" | "keywords">>;

/**
 * FAQs and policies of ONE restaurant. Customer-facing reads (`listPublishedFaqs`, `getPublishedPolicy`) can only ever
 * return published content; drafts and archived entries are reachable only through the `...Any...` / admin methods.
 */
export class KnowledgeRepository {
  private readonly faqs: ScopedCollection<Faq>;
  private readonly policies: ScopedCollection<Policy>;
  constructor(cols: Collections, restaurantId: RestaurantId) {
    this.faqs = new ScopedCollection(cols.faqs, restaurantId);
    this.policies = new ScopedCollection(cols.policies, restaurantId);
  }

  // ------------------------------------------------------------------ assistant (published only)
  /** At most FAQ_MAX_PER_RESTAURANT entries (a service-enforced cap), so retrieval can rank them in memory. */
  listPublishedFaqs(): Promise<Faq[]> {
    return this.faqs.find({ status: "published" }, { limit: FAQ_MAX_PER_RESTAURANT, sort: { slug: 1 } });
  }

  getPublishedPolicy(kind: PolicyKind): Promise<Policy | null> {
    if (!POLICY_KINDS.includes(kind)) return Promise.resolve(null);
    return this.policies.findOne({ kind, status: "published" });
  }

  // ------------------------------------------------------------------ FAQ management
  async createFaq(input: NewFaq, now = new Date()): Promise<void> {
    const doc = faqSchema.parse({
      ...input,
      keywords: normalizeKeywords(input.keywords ?? []),
      status: "draft", // nothing goes live without an explicit publish
      restaurantId: this.faqs.restaurantId,
      createdAt: now,
      updatedAt: now,
    });
    const { restaurantId: _omit, ...rest } = doc;
    void _omit;
    // The driver would store an explicit `undefined` as null, which the schema rejects on read: drop such keys.
    if (rest.category === undefined) delete rest.category;
    try {
      await this.faqs.insertOne(rest);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError(409, "conflict", "FAQ slug already exists");
      throw err;
    }
  }

  findAnyFaqBySlug(slug: string): Promise<Faq | null> {
    return this.faqs.findOne({ slug: String(slug) });
  }

  /** Draft + published (archived entries do not count towards the cap). */
  countLiveFaqs(): Promise<number> {
    return this.faqs.countDocuments({ status: { $in: ["draft", "published"] } });
  }

  /** Stable order by slug so `after` works as a cursor on the unique (restaurantId, slug) index. */
  listFaqsForAdmin(opts: { status: Faq["status"] | "live" | "all"; category?: string; after?: string; limit: number }): Promise<Faq[]> {
    return this.faqs.find(
      {
        ...(opts.status === "all" ? {} : opts.status === "live" ? { status: { $in: ["draft", "published"] as Faq["status"][] } } : { status: opts.status }),
        ...(opts.category ? { category: String(opts.category) } : {}),
        ...(opts.after ? { slug: { $gt: String(opts.after) } } : {}),
      },
      { limit: opts.limit, sort: { slug: 1 } },
    );
  }

  async updateFaq(slug: string, patch: FaqPatch, now = new Date()): Promise<{ faq: Faq; changed: string[] } | null> {
    const current = await this.findAnyFaqBySlug(slug);
    if (!current) return null;
    const plan = planFaqPatch(current, patch, now);
    if (plan.changed.length === 0) return { faq: current, changed: [] };
    const res = await this.faqs.updateOne(
      { slug },
      { $set: plan.set, ...(plan.unset.length > 0 ? { $unset: Object.fromEntries(plan.unset.map((k) => [k, ""])) } : {}) },
    );
    return res.matchedCount === 1 ? { faq: plan.next, changed: plan.changed } : null;
  }

  async setFaqStatus(slug: string, status: Faq["status"], now = new Date()): Promise<boolean> {
    const res = await this.faqs.updateOne(
      { slug },
      status === "published"
        ? { $set: { status, publishedAt: now, updatedAt: now } }
        : { $set: { status, updatedAt: now }, $unset: { publishedAt: "" } },
    );
    return res.matchedCount === 1;
  }

  // ------------------------------------------------------------------ policy management
  getAnyPolicy(kind: PolicyKind): Promise<Policy | null> {
    return this.policies.findOne({ kind });
  }

  listPolicies(): Promise<Policy[]> {
    return this.policies.find({}, { limit: POLICY_KINDS.length, sort: { kind: 1 } });
  }

  /**
   * Creates the policy as a DRAFT, or replaces title/body of an existing one WITHOUT changing its status.
   * (Insert-or-update rather than upsert: the unique (restaurantId, kind) index settles a concurrent first write.)
   */
  async savePolicy(kind: PolicyKind, input: { title: string; body: string }, now = new Date()): Promise<Policy> {
    const existing = await this.getAnyPolicy(kind);
    if (existing) {
      const next = policySchema.parse({ ...existing, title: input.title, body: input.body, updatedAt: now });
      await this.policies.updateOne({ kind }, { $set: { title: next.title, body: next.body, updatedAt: now } });
      return next;
    }
    const doc = policySchema.parse({ restaurantId: this.policies.restaurantId, kind, ...input, status: "draft", createdAt: now, updatedAt: now });
    const { restaurantId: _omit, ...rest } = doc;
    void _omit;
    try {
      await this.policies.insertOne(rest);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError(409, "conflict", "Policy was created concurrently; retry");
      throw err;
    }
    return doc;
  }

  async setPolicyStatus(kind: PolicyKind, status: Policy["status"], now = new Date()): Promise<boolean> {
    const res = await this.policies.updateOne(
      { kind },
      status === "published"
        ? { $set: { status, publishedAt: now, updatedAt: now } }
        : { $set: { status, updatedAt: now }, $unset: { publishedAt: "" } },
    );
    return res.matchedCount === 1;
  }
}
