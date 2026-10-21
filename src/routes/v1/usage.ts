import type { Router } from "express";
import { z } from "zod";
import { requireTenant } from "../../middleware/auth.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { UsageAdminService } from "../../services/usage/usageAdminService.js";
import { parseInput } from "./validation.js";

export const usageQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** `GET /v1/restaurants/:restaurantId/usage`: AI usage and estimated cost for one restaurant (permission `usage:read`). */
export function mountUsageRoutes(tenant: Router, deps: { store: AccountStore; usage: UsageAdminService }): void {
  tenant.get("/usage", requireTenant(deps.store, "usage:read"), async (req, res) => {
    const q = parseInput(usageQuery, req.query);
    res.json(await deps.usage.report(req.tenant!.restaurantId, { from: q.from, to: q.to, limit: q.limit }));
  });
}
