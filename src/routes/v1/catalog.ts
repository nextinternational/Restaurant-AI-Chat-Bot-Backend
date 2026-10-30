import type { RequestHandler, Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Env } from "../../config/env.js";
import { AppError } from "../../errors.js";
import { requireTenant } from "../../middleware/auth.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { CatalogAdminService } from "../../services/catalog/catalogAdminService.js";
import { createItemBody, hoursBody, isSlug, listItemsQuery, updateItemBody, verifyAllergensBody } from "./catalogValidation.js";
import { parseInput } from "./validation.js";

/** Unknown / malformed slugs are a plain 404: nothing about the format is echoed back. */
function slugParam(raw: unknown): string {
  if (!isSlug(raw)) throw new AppError(404, "not_found", "Resource not found");
  return raw;
}

/**
 * Menu, allergen-verification and opening-hours endpoints, mounted on the tenant router
 * (`/v1/restaurants/:restaurantId/...`, already behind `authenticate`).
 * The restaurant id is a URL CLAIM until `requireTenant` has checked membership and permission.
 */
export function mountCatalogRoutes(tenant: Router, deps: { env: Env; store: AccountStore; catalog: CatalogAdminService }): void {
  const { env, store, catalog } = deps;

  // Per-USER write budget: a stolen or runaway staff session cannot rewrite the whole menu in a loop.
  // In-memory per container, like the other limiters (see README "known limits").
  const writeLimit: RequestHandler = rateLimit({
    windowMs: 60_000,
    limit: env.ADMIN_WRITE_RATE_LIMIT_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `catalog:${req.auth?.userId ?? "anonymous"}`,
    handler: (req, res) => {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many changes, slow down", requestId: req.id } });
    },
  });

  // ------------------------------------------------------------------ menu
  tenant.get("/menu/items", requireTenant(store, "menu:read"), async (req, res) => {
    const q = parseInput(listItemsQuery, req.query);
    res.json(await catalog.listItems(req.tenant!.restaurantId, {
      status: q.status, limit: q.limit,
      ...(q.category !== undefined ? { category: q.category } : {}),
      ...(q.after !== undefined ? { after: q.after } : {}),
    }));
  });

  tenant.post("/menu/items", requireTenant(store, "menu:write"), writeLimit, async (req, res) => {
    const b = parseInput(createItemBody, req.body);
    const t = req.tenant!;
    res.status(201).json(await catalog.createItem(t.restaurantId, t.userId, {
      name: b.name, category: b.category, priceCents: b.priceCents, available: b.available, dietaryTags: b.dietaryTags,
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
    }));
  });

  tenant.get("/menu/items/:slug", requireTenant(store, "menu:read"), async (req, res) => {
    res.json(await catalog.getItem(req.tenant!.restaurantId, slugParam(req.params.slug)));
  });

  tenant.patch("/menu/items/:slug", requireTenant(store, "menu:write"), writeLimit, async (req, res) => {
    const slug = slugParam(req.params.slug);
    const b = parseInput(updateItemBody, req.body);
    const t = req.tenant!;
    res.json(await catalog.updateItem(t.restaurantId, t.userId, slug, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.category !== undefined ? { category: b.category } : {}),
      ...(b.priceCents !== undefined ? { priceCents: b.priceCents } : {}),
      ...(b.available !== undefined ? { available: b.available } : {}),
      ...(b.dietaryTags !== undefined ? { dietaryTags: b.dietaryTags } : {}),
    }));
  });

  tenant.delete("/menu/items/:slug", requireTenant(store, "menu:write"), writeLimit, async (req, res) => {
    await catalog.archiveItem(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug));
    res.status(204).end();
  });

  tenant.post("/menu/items/:slug/restore", requireTenant(store, "menu:write"), writeLimit, async (req, res) => {
    res.json(await catalog.restoreItem(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug)));
  });

  // ------------------------------------------------------------------ allergens (separate permission on purpose)
  tenant.put("/menu/items/:slug/allergens", requireTenant(store, "allergens:verify"), writeLimit, async (req, res) => {
    const slug = slugParam(req.params.slug);
    const b = parseInput(verifyAllergensBody, req.body);
    res.json(await catalog.verifyAllergens(req.tenant!.restaurantId, req.tenant!.userId, slug, b.allergens));
  });

  tenant.delete("/menu/items/:slug/allergens/verification", requireTenant(store, "allergens:verify"), writeLimit, async (req, res) => {
    res.json(await catalog.revokeAllergenVerification(req.tenant!.restaurantId, req.tenant!.userId, slugParam(req.params.slug)));
  });

  // ------------------------------------------------------------------ opening hours
  tenant.get("/hours", requireTenant(store, "hours:read"), async (req, res) => {
    res.json(await catalog.getHours(req.tenant!.restaurantId));
  });

  tenant.put("/hours", requireTenant(store, "hours:write"), writeLimit, async (req, res) => {
    const b = parseInput(hoursBody, req.body);
    res.json(await catalog.replaceHours(req.tenant!.restaurantId, req.tenant!.userId, {
      weekly: b.weekly,
      exceptions: b.exceptions.map((e) => ({ date: e.date, closed: e.closed, periods: e.periods, note: e.note })),
    }));
  });
}
