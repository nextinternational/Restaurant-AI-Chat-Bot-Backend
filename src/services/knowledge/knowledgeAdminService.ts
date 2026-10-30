import { randomBytes } from "node:crypto";
import { AppError } from "../../errors.js";
import type { RestaurantId } from "../../domain/ids.js";
import { POLICY_LABELS, type FaqPatch } from "../../domain/knowledgeRules.js";
import { FAQ_MAX_PER_RESTAURANT, POLICY_KINDS, type Faq, type Policy, type PolicyKind } from "../../domain/schemas.js";
import { slugify } from "../../domain/slug.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { KnowledgeGateway, KnowledgeTenantContext } from "./gateway.js";

const notFound = () => new AppError(404, "not_found", "Resource not found");

export interface NewFaqInput {
  question: string;
  answer: string;
  slug?: string;
  category?: string;
  keywords: string[];
}

/** What staff see. Never contains the tenant id. */
export function toAdminFaq(f: Faq) {
  return {
    slug: f.slug, question: f.question, answer: f.answer, category: f.category ?? null, keywords: f.keywords,
    status: f.status, publishedAt: f.publishedAt ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt,
  };
}
export type AdminFaq = ReturnType<typeof toAdminFaq>;

export function toAdminPolicy(p: Policy) {
  return { kind: p.kind, title: p.title, body: p.body, status: p.status, publishedAt: p.publishedAt ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt };
}
export type AdminPolicy = ReturnType<typeof toAdminPolicy>;

/**
 * Staff-side management of the FAQ / policy knowledge base.
 *
 * Content lifecycle: new entries are DRAFTS. Only `published` content is ever visible to the assistant, so staff can
 * prepare and review text before it can be quoted to customers. `restaurantId` must be the server-verified one from
 * `requireTenant`; the actor id comes from the session, never the body. Every mutation is audited (what changed, never
 * the text itself). Nothing here is reachable by the AI model or the public widget.
 */
export class KnowledgeAdminService {
  constructor(
    private readonly gateway: KnowledgeGateway,
    private readonly store: Pick<AccountStore, "recordAudit">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async ctx(restaurantId: RestaurantId): Promise<KnowledgeTenantContext> {
    const t = await this.gateway.tenantContext(restaurantId);
    if (!t) throw notFound();
    return t;
  }

  private audit(restaurantId: RestaurantId, actorUserId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>, now: Date) {
    return this.store.recordAudit(restaurantId, { actorUserId, action, resourceType, resourceId, metadata }, now);
  }

  private async assertRoomForFaq(t: KnowledgeTenantContext): Promise<void> {
    if ((await t.knowledge.countLiveFaqs()) >= FAQ_MAX_PER_RESTAURANT) {
      throw new AppError(409, "faq_limit_reached", `A restaurant can have at most ${FAQ_MAX_PER_RESTAURANT} draft or published FAQs; archive some first`);
    }
  }

  private async faqOrThrow(t: KnowledgeTenantContext, slug: string): Promise<Faq> {
    const faq = await t.knowledge.findAnyFaqBySlug(slug);
    if (!faq) throw notFound();
    return faq;
  }

  // ------------------------------------------------------------------ FAQs
  async listFaqs(restaurantId: RestaurantId, q: { status: Faq["status"] | "live" | "all"; category?: string; after?: string; limit: number }) {
    const t = await this.ctx(restaurantId);
    const rows = await t.knowledge.listFaqsForAdmin({ ...q, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    return { faqs: page.map(toAdminFaq), nextCursor: rows.length > q.limit ? page[page.length - 1]!.slug : null };
  }

  async getFaq(restaurantId: RestaurantId, slug: string): Promise<AdminFaq> {
    return toAdminFaq(await this.faqOrThrow(await this.ctx(restaurantId), slug));
  }

  async createFaq(restaurantId: RestaurantId, actorUserId: string, input: NewFaqInput): Promise<AdminFaq> {
    const t = await this.ctx(restaurantId);
    await this.assertRoomForFaq(t);

    // A slug is only an identifier for the URL: derive one when the staff member did not choose it. Arabic questions
    // have no Latin letters, so they fall back to "faq"; a random suffix keeps it unique without a check-then-insert race.
    let slug = input.slug ?? (slugify(input.question) || "faq");
    if (await t.knowledge.findAnyFaqBySlug(slug)) {
      if (input.slug) throw new AppError(409, "duplicate_slug", "An FAQ with this slug already exists");
      slug = `${slug.slice(0, 70)}-${randomBytes(3).toString("hex")}`;
    }

    const now = this.clock();
    await t.knowledge.createFaq({
      slug, question: input.question, answer: input.answer, keywords: input.keywords,
      ...(input.category !== undefined ? { category: input.category } : {}),
    }, now);
    const created = await this.faqOrThrow(t, slug);
    await this.audit(restaurantId, actorUserId, "faq.created", "faq", slug, { status: "draft" }, now);
    return toAdminFaq(created);
  }

  /** Editing keeps the entry's status: changes to a PUBLISHED entry are live immediately (the audit entry says so). */
  async updateFaq(restaurantId: RestaurantId, actorUserId: string, slug: string, patch: FaqPatch): Promise<AdminFaq> {
    const t = await this.ctx(restaurantId);
    const before = await this.faqOrThrow(t, slug);
    if (before.status === "archived") throw new AppError(409, "invalid_state", "Restore this FAQ before editing it");
    const now = this.clock();
    const result = await t.knowledge.updateFaq(slug, patch, now);
    if (!result) throw notFound();
    if (result.changed.length > 0) {
      await this.audit(restaurantId, actorUserId, "faq.updated", "faq", slug, { fields: result.changed, live: before.status === "published" }, now);
    }
    return toAdminFaq(result.faq);
  }

  /** draft -> published. Idempotent. The entry becomes quotable by the assistant immediately. */
  async publishFaq(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<AdminFaq> {
    const t = await this.ctx(restaurantId);
    const faq = await this.faqOrThrow(t, slug);
    if (faq.status === "published") return toAdminFaq(faq);
    if (faq.status === "archived") throw new AppError(409, "invalid_state", "Restore this FAQ before publishing it");
    const now = this.clock();
    await t.knowledge.setFaqStatus(slug, "published", now);
    await this.audit(restaurantId, actorUserId, "faq.published", "faq", slug, {}, now);
    return toAdminFaq(await this.faqOrThrow(t, slug));
  }

  /** published -> draft: the assistant stops using it at once. Idempotent. */
  async unpublishFaq(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<AdminFaq> {
    const t = await this.ctx(restaurantId);
    const faq = await this.faqOrThrow(t, slug);
    if (faq.status === "draft") return toAdminFaq(faq);
    if (faq.status === "archived") throw new AppError(409, "invalid_state", "This FAQ is archived");
    const now = this.clock();
    await t.knowledge.setFaqStatus(slug, "draft", now);
    await this.audit(restaurantId, actorUserId, "faq.unpublished", "faq", slug, {}, now);
    return toAdminFaq(await this.faqOrThrow(t, slug));
  }

  /** Soft delete from any state. Idempotent. */
  async archiveFaq(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<void> {
    const t = await this.ctx(restaurantId);
    const faq = await this.faqOrThrow(t, slug);
    if (faq.status === "archived") return;
    const now = this.clock();
    await t.knowledge.setFaqStatus(slug, "archived", now);
    await this.audit(restaurantId, actorUserId, "faq.archived", "faq", slug, { wasPublished: faq.status === "published" }, now);
  }

  /** archived -> draft. It must be published again on purpose. */
  async restoreFaq(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<AdminFaq> {
    const t = await this.ctx(restaurantId);
    const faq = await this.faqOrThrow(t, slug);
    if (faq.status !== "archived") return toAdminFaq(faq);
    await this.assertRoomForFaq(t);
    const now = this.clock();
    await t.knowledge.setFaqStatus(slug, "draft", now);
    await this.audit(restaurantId, actorUserId, "faq.restored", "faq", slug, {}, now);
    return toAdminFaq(await this.faqOrThrow(t, slug));
  }

  // ------------------------------------------------------------------ policies
  async listPolicies(restaurantId: RestaurantId) {
    const t = await this.ctx(restaurantId);
    const rows = await t.knowledge.listPolicies();
    const have = new Set(rows.map((p) => p.kind));
    return { policies: rows.map(toAdminPolicy), unconfiguredKinds: POLICY_KINDS.filter((k) => !have.has(k)) };
  }

  async getPolicy(restaurantId: RestaurantId, kind: PolicyKind): Promise<AdminPolicy> {
    const p = await (await this.ctx(restaurantId)).knowledge.getAnyPolicy(kind);
    if (!p) throw notFound();
    return toAdminPolicy(p);
  }

  /** Creates the policy as a draft, or edits an existing one keeping its status (a published policy changes live). */
  async savePolicy(restaurantId: RestaurantId, actorUserId: string, kind: PolicyKind, input: { title?: string; body: string }): Promise<AdminPolicy> {
    const t = await this.ctx(restaurantId);
    const before = await t.knowledge.getAnyPolicy(kind);
    const now = this.clock();
    const saved = await t.knowledge.savePolicy(kind, { title: input.title ?? before?.title ?? POLICY_LABELS.get(kind) ?? kind, body: input.body }, now);
    await this.audit(restaurantId, actorUserId, before ? "policy.updated" : "policy.created", "policy", kind, {
      status: saved.status, live: before?.status === "published",
    }, now);
    return toAdminPolicy(saved);
  }

  async publishPolicy(restaurantId: RestaurantId, actorUserId: string, kind: PolicyKind): Promise<AdminPolicy> {
    const t = await this.ctx(restaurantId);
    const p = await t.knowledge.getAnyPolicy(kind);
    if (!p) throw notFound();
    if (p.status === "published") return toAdminPolicy(p);
    const now = this.clock();
    await t.knowledge.setPolicyStatus(kind, "published", now);
    await this.audit(restaurantId, actorUserId, "policy.published", "policy", kind, {}, now);
    return this.getPolicy(restaurantId, kind);
  }

  async unpublishPolicy(restaurantId: RestaurantId, actorUserId: string, kind: PolicyKind): Promise<AdminPolicy> {
    const t = await this.ctx(restaurantId);
    const p = await t.knowledge.getAnyPolicy(kind);
    if (!p) throw notFound();
    if (p.status === "draft") return toAdminPolicy(p);
    const now = this.clock();
    await t.knowledge.setPolicyStatus(kind, "draft", now);
    await this.audit(restaurantId, actorUserId, "policy.unpublished", "policy", kind, {}, now);
    return this.getPolicy(restaurantId, kind);
  }
}
