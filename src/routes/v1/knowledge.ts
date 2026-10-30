import type { RequestHandler, Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Env } from "../../config/env.js";
import { AppError } from "../../errors.js";
import { requireTenant } from "../../middleware/auth.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { KnowledgeAdminService } from "../../services/knowledge/knowledgeAdminService.js";
import { isSlug } from "./catalogValidation.js";
import { createFaqBody, isPolicyKind, listFaqsQuery, policyBody, updateFaqBody } from "./knowledgeValidation.js";
import { parseInput } from "./validation.js";

/** Unknown / malformed identifiers are a plain 404: nothing about the format is echoed back. */
function slugParam(raw: unknown): string {
  if (!isSlug(raw)) throw new AppError(404, "not_found", "Resource not found");
  return raw;
}
function kindParam(raw: unknown) {
  if (!isPolicyKind(raw)) throw new AppError(404, "not_found", "Resource not found");
  return raw;
}

/**
 * FAQ and policy endpoints, mounted on the tenant router (`/v1/restaurants/:restaurantId/...`, already behind `authenticate`).
 * The restaurant id is a URL CLAIM until `requireTenant` has checked membership and permission.
 */
export function mountKnowledgeRoutes(tenant: Router, deps: { env: Env; store: AccountStore; knowledge: KnowledgeAdminService }): void {
  const { env, store, knowledge } = deps;

  // Per-USER write budget, like the catalog routes (in-memory per container; see README "known limits").
  const writeLimit: RequestHandler = rateLimit({
    windowMs: 60_000,
    limit: env.ADMIN_WRITE_RATE_LIMIT_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `knowledge:${req.auth?.userId ?? "anonymous"}`,
    handler: (req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many changes, slow down", requestId: req.id } });
    },
  });

  // ------------------------------------------------------------------ FAQs
  tenant.get("/faqs", requireTenant(store, "knowledge:read"), async (req, res) => {
    const q = parseInput(listFaqsQuery, req.query);
    res.json(await knowledge.listFaqs(req.tenant!.restaurantId, {
      status: q.status, limit: q.limit,
      ...(q.category !== undefined ? { category: q.category } : {}),
      ...(q.after !== undefined ? { after: q.after } : {}),
    }));
  });

  tenant.post("/faqs", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    const b = parseInput(createFaqBody, req.body);
    const t = req.tenant!;
    res.status(201).json(await knowledge.createFaq(t.restaurantId, t.userId, {
      question: b.question, answer: b.answer, keywords: b.keywords,
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.category !== undefined ? { category: b.category } : {}),
    }));
  });

  tenant.get("/faqs/:slug", requireTenant(store, "knowledge:read"), async (req, res) => {
    res.json(await knowledge.getFaq(req.tenant!.restaurantId, slugParam(req.params.slug)));
  });

  tenant.patch("/faqs/:slug", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    const slug = slugParam(req.params.slug);
    const b = parseInput(updateFaqBody, req.body);
    const t = req.tenant!;
    res.json(await knowledge.updateFaq(t.restaurantId, t.userId, slug, {
      ...(b.question !== undefined ? { question: b.question } : {}),
      ...(b.answer !== undefined ? { answer: b.answer } : {}),
      ...(b.category !== undefined ? { category: b.category } : {}),
      ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
    }));
  });

  tenant.post("/faqs/:slug/publish", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    res.json(await knowledge.publishFaq(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug)));
  });

  tenant.post("/faqs/:slug/unpublish", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    res.json(await knowledge.unpublishFaq(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug)));
  });

  tenant.post("/faqs/:slug/restore", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    res.json(await knowledge.restoreFaq(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug)));
  });

  tenant.delete("/faqs/:slug", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    await knowledge.archiveFaq(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug));
    res.status(204).end();
  });

  // ------------------------------------------------------------------ policies (one per kind)
  tenant.get("/policies", requireTenant(store, "knowledge:read"), async (req, res) => {
    res.json(await knowledge.listPolicies(req.tenant!.restaurantId));
  });

  tenant.get("/policies/:kind", requireTenant(store, "knowledge:read"), async (req, res) => {
    res.json(await knowledge.getPolicy(req.tenant!.restaurantId, kindParam(req.params.kind)));
  });

  tenant.put("/policies/:kind", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    const kind = kindParam(req.params.kind);
    const b = parseInput(policyBody, req.body);
    const t = req.tenant!;
    res.json(await knowledge.savePolicy(t.restaurantId, t.userId, kind, { body: b.body, ...(b.title !== undefined ? { title: b.title } : {}) }));
  });

  tenant.post("/policies/:kind/publish", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    res.json(await knowledge.publishPolicy(req.tenant!.restaurantId, req.tenant!.userId, kindParam(req.params.kind)));
  });

  tenant.post("/policies/:kind/unpublish", requireTenant(store, "knowledge:write"), writeLimit, async (req, res) => {
    res.json(await knowledge.unpublishPolicy(req.tenant!.restaurantId, req.tenant!.userId, kindParam(req.params.kind)));
  });
}
