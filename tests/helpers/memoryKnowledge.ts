import type { RestaurantId } from "../../src/domain/ids.js";
import { normalizeKeywords, planFaqPatch } from "../../src/domain/knowledgeRules.js";
import { faqSchema, policySchema, type Faq, type Policy } from "../../src/domain/schemas.js";
import { AppError } from "../../src/errors.js";
import type { KnowledgeGateway, KnowledgeTenantContext } from "../../src/services/knowledge/gateway.js";

/**
 * Per-tenant in-memory stores with the same observable contract as KnowledgeRepository.
 * Patch logic is the SHARED `planFaqPatch`, so rules cannot drift between this double and production.
 */
class Tenant {
  faqs: Faq[] = [];
  policies: Policy[] = [];
}

export class MemoryKnowledgeGateway implements KnowledgeGateway {
  tenants = new Map<string, Tenant>();

  async tenantContext(restaurantId: RestaurantId): Promise<KnowledgeTenantContext | null> {
    const t = this.tenants.get(restaurantId) ?? new Tenant();
    this.tenants.set(restaurantId, t);
    const find = (slug: string) => t.faqs.find((f) => f.slug === slug) ?? null;
    return {
      restaurant: { restaurantId },
      knowledge: {
        createFaq: async (input, now = new Date()) => {
          if (find(input.slug)) throw new AppError(409, "conflict", "FAQ slug already exists");
          t.faqs.push(faqSchema.parse({ ...input, keywords: normalizeKeywords(input.keywords ?? []), status: "draft", restaurantId, createdAt: now, updatedAt: now }));
        },
        findAnyFaqBySlug: async (slug) => find(slug),
        countLiveFaqs: async () => t.faqs.filter((f) => f.status !== "archived").length,
        listFaqsForAdmin: async (o) =>
          t.faqs
            .filter((f) => (o.status === "all" || (o.status === "live" ? f.status !== "archived" : f.status === o.status)) && (!o.category || f.category === o.category) && (!o.after || f.slug > o.after))
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .slice(0, o.limit),
        updateFaq: async (slug, patch, now = new Date()) => {
          const current = find(slug);
          if (!current) return null;
          const plan = planFaqPatch(current, patch, now);
          if (plan.changed.length > 0) t.faqs = t.faqs.map((f) => (f === current ? plan.next : f));
          return { faq: plan.next, changed: plan.changed };
        },
        setFaqStatus: async (slug, status, now = new Date()) => {
          const f = find(slug);
          if (!f) return false;
          f.status = status;
          f.updatedAt = now;
          if (status === "published") f.publishedAt = now;
          else delete f.publishedAt;
          return true;
        },
        getAnyPolicy: async (kind) => t.policies.find((p) => p.kind === kind) ?? null,
        listPolicies: async () => [...t.policies].sort((a, b) => a.kind.localeCompare(b.kind)),
        savePolicy: async (kind, input, now = new Date()) => {
          const existing = t.policies.find((p) => p.kind === kind);
          if (existing) {
            const next = policySchema.parse({ ...existing, ...input, updatedAt: now });
            t.policies = t.policies.map((p) => (p === existing ? next : p));
            return next;
          }
          const created = policySchema.parse({ restaurantId, kind, ...input, status: "draft", createdAt: now, updatedAt: now });
          t.policies.push(created);
          return created;
        },
        setPolicyStatus: async (kind, status, now = new Date()) => {
          const p = t.policies.find((x) => x.kind === kind);
          if (!p) return false;
          p.status = status;
          p.updatedAt = now;
          if (status === "published") p.publishedAt = now;
          else delete p.publishedAt;
          return true;
        },
      },
    };
  }
}
