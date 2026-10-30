import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Env } from "../../config/env.js";
import { authenticate, requireTenant } from "../../middleware/auth.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { AuthService } from "../../services/authService.js";
import type { TenantAdminService } from "../../services/tenantAdminService.js";
import type { CatalogAdminService } from "../../services/catalog/catalogAdminService.js";
import type { KnowledgeAdminService } from "../../services/knowledge/knowledgeAdminService.js";
import { mountCatalogRoutes } from "./catalog.js";
import type { UsageAdminService } from "../../services/usage/usageAdminService.js";
import { mountKnowledgeRoutes } from "./knowledge.js";
import { mountUsageRoutes } from "./usage.js";
import { auditQuery, loginBody, parseInput, restaurantPatchBody, signupBody, widgetKeyBody } from "./validation.js";

export interface V1Deps {
  env: Env;
  store: AccountStore;
  auth: AuthService;
  admin: TenantAdminService;
  /** Present when menu/hours management is enabled (Step 7). */
  catalog?: CatalogAdminService;
  /** Present when FAQ / policy management is enabled. */
  knowledge?: KnowledgeAdminService;
  /** Present when the AI usage / cost report is enabled. */
  usage?: UsageAdminService;
}

const limited: RequestHandler = (req, res) => {
  res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts, try again later", requestId: req.id } });
};

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store"); // tokens and tenant data must never be cached by proxies
  next();
};

/**
 * NOTE: limiters are in-memory (per container). Before running more than one task behind the ALB,
 * back them with a shared store (Redis / Mongo) so the budget is global.
 */
export function createV1Router({ env, store, auth, admin, catalog, knowledge, usage }: V1Deps): Router {
  const router = Router();
  router.use(noStore);

  const authenticated = authenticate(auth);
  const windowMs = 15 * 60_000;

  const perIp = rateLimit({ windowMs, limit: env.AUTH_RATE_LIMIT_PER_15MIN, standardHeaders: "draft-7", legacyHeaders: false, handler: limited });
  // Slows password guessing against ONE account even when the attacker rotates IPs. Successful logins don't count.
  const perEmail = rateLimit({
    windowMs, limit: env.LOGIN_RATE_LIMIT_PER_EMAIL_15MIN, skipSuccessfulRequests: true, standardHeaders: false, legacyHeaders: false,
    keyGenerator: (req) => {
      const e: unknown = (req.body as { email?: unknown } | undefined)?.email;
      return `login:${typeof e === "string" ? e.trim().toLowerCase().slice(0, 320) : "-"}`;
    },
    handler: limited,
  });

  // ------------------------------------------------------------------ auth
  // Self-service signup creates tenants. Restaurants are operator-provisioned (CLI), so it is off unless
  // ALLOW_PUBLIC_SIGNUP=true (kept only for local experiments / tests).
  if (env.ALLOW_PUBLIC_SIGNUP) {
    router.post("/auth/signup", perIp, async (req, res) => {
      const body = parseInput(signupBody, req.body);
      res.status(201).json(await auth.signup(body));
    });
  }

  router.post("/auth/login", perIp, perEmail, async (req, res) => {
    const body = parseInput(loginBody, req.body);
    res.json(await auth.login(body.email, body.password));
  });

  router.post("/auth/logout", authenticated, async (req, res) => {
    await auth.logout(req.auth!.tokenHash);
    res.status(204).end();
  });

  router.post("/auth/logout-all", authenticated, async (req, res) => {
    await auth.logoutEverywhere(req.auth!.userId);
    res.status(204).end();
  });

  router.get("/me", authenticated, async (req, res) => {
    res.json(await auth.me(req.auth!.userId));
  });

  // ------------------------------------------------------------------ tenant-scoped admin API
  const tenant = Router({ mergeParams: true });
  tenant.use(authenticated);

  tenant.get("/", requireTenant(store, "restaurant:read"), async (req, res) => {
    const r = await admin.getRestaurant(req.tenant!.restaurantId);
    res.json({
      restaurantId: r.restaurantId, slug: r.slug, name: r.name, status: r.status, timezone: r.timezone,
      currency: r.currency, defaultLocale: r.defaultLocale, createdAt: r.createdAt, role: req.tenant!.role,
    });
  });

  tenant.patch("/", requireTenant(store, "restaurant:write"), async (req, res) => {
    const patch = parseInput(restaurantPatchBody, req.body);
    const t = req.tenant!;
    const r = await admin.updateRestaurant(t.restaurantId, t.userId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.defaultLocale !== undefined ? { defaultLocale: patch.defaultLocale } : {}),
    });
    res.json({ restaurantId: r.restaurantId, name: r.name, timezone: r.timezone, defaultLocale: r.defaultLocale, updatedAt: r.updatedAt });
  });

  tenant.get("/team", requireTenant(store, "team:read"), async (req, res) => {
    res.json({ members: await admin.listTeam(req.tenant!.restaurantId) });
  });

  tenant.get("/subscription", requireTenant(store, "billing:read"), async (req, res) => {
    const { subscription: s, plan } = await admin.getSubscription(req.tenant!.restaurantId);
    res.json({
      status: s.status, planCode: s.planCode, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd,
      plan: plan && {
        name: plan.name, monthlyPriceCents: plan.monthlyPriceCents, currency: plan.currency,
        monthlyMessageLimit: plan.monthlyMessageLimit, features: plan.features,
      },
    });
  });

  tenant.get("/audit-logs", requireTenant(store, "audit:read"), async (req, res) => {
    const q = parseInput(auditQuery, req.query);
    res.json({ entries: await admin.listAudit(req.tenant!.restaurantId, q.limit, q.before) });
  });

  tenant.get("/widget-keys", requireTenant(store, "widgets:manage"), async (req, res) => {
    res.json({ keys: await admin.listWidgetKeys(req.tenant!.restaurantId) });
  });

  tenant.post("/widget-keys", requireTenant(store, "widgets:manage"), async (req, res) => {
    const body = parseInput(widgetKeyBody, req.body);
    const t = req.tenant!;
    res.status(201).json(await admin.createWidgetKey(t.restaurantId, t.userId, {
      allowedOrigins: body.allowedOrigins,
      ...(body.label !== undefined ? { label: body.label } : {}),
    }));
  });

  tenant.delete("/widget-keys/:keyId", requireTenant(store, "widgets:manage"), async (req, res) => {
    const keyId = req.params.keyId;
    await admin.revokeWidgetKey(req.tenant!.restaurantId, req.tenant!.userId, typeof keyId === "string" ? keyId : "");
    res.status(204).end();
  });

  if (catalog) mountCatalogRoutes(tenant, { env, store, catalog });
  if (knowledge) mountKnowledgeRoutes(tenant, { env, store, knowledge });
  if (usage) mountUsageRoutes(tenant, { store, usage });

  router.use("/restaurants/:restaurantId", tenant);
  return router;
}
