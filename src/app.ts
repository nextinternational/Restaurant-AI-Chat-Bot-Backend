import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { Env } from "./config/env.js";
import { requestId } from "./middleware/requestId.js";
import { createErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { healthRouter, type ReadinessCheck } from "./routes/health.js";
import type { AccountStore } from "./repositories/accountStore.js";
import { AuthService } from "./services/authService.js";
import { TenantAdminService } from "./services/tenantAdminService.js";
import { createV1Router } from "./routes/v1/index.js";
import { createChatRouter } from "./routes/chat.js";
import type { ChatService } from "./services/chat/chatService.js";
import type { CatalogAdminService } from "./services/catalog/catalogAdminService.js";
import type { KnowledgeAdminService } from "./services/knowledge/knowledgeAdminService.js";
import type { UsageAdminService } from "./services/usage/usageAdminService.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  readinessChecks: ReadinessCheck[];
  /** Enables the /v1 account + admin API. Omitted in tests that only exercise infrastructure. */
  accounts?: AccountStore;
  /** Enables the public widget chat API (/v1/chat/:widgetKey/*). */
  chat?: { service: ChatService };
  /** Enables menu, allergen-verification and opening-hours management under /v1/restaurants/:id (Step 7). */
  catalog?: CatalogAdminService;
  /** Enables FAQ and policy management under /v1/restaurants/:id. */
  knowledge?: KnowledgeAdminService;
  usage?: UsageAdminService;
  clock?: () => Date;
}

/** The widget ships inside the image (see Dockerfile) so WordPress sites can load it straight from the API host. */
function loadWidgetSource(): string | null {
  try {
    const path = fileURLToPath(new URL("../widget/chat-widget.js", import.meta.url)); // fixed path, no user input
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function createApp({ env, logger, readinessChecks, accounts, chat, catalog, knowledge, usage, clock }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      // Load-balancer probes every few seconds would drown real traffic in the logs.
      autoLogging: { ignore: (req) => req.url?.startsWith("/health/") ?? false },
    }),
  );

  // API-only server: strict CSP, no framing, no sniffing, HSTS in production.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: "no-referrer" },
      hsts: env.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // Health probes are mounted BEFORE the rate limiter: if the ALB's checks were throttled (429) the
  // target would be marked unhealthy and taken out of rotation exactly when the service is under load.
  app.use("/health", healthRouter(readinessChecks, logger));

  // Staff/admin origins only. The public widget (/v1/chat/*) does its own per-tenant origin check,
  // so this global policy must not answer (or block) its preflight requests.
  const staffCors = cors({
    origin: env.CORS_ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    maxAge: 600,
  });
  app.use((req, res, next) => (req.path.startsWith("/v1/chat/") ? next() : staffCors(req, res, next)));

  // Coarse per-IP guard. Finer per-tenant / per-session limits come in Step 3.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.RATE_LIMIT_GLOBAL_PER_MIN,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (req, res) => {
        res.status(429).json({ error: { code: "rate_limited", message: "Too many requests", requestId: req.id } });
      },
    }),
  );

  // Public, static widget script. Helmet's default Cross-Origin-Resource-Policy is same-origin, which would stop
  // the restaurants' sites from loading it, so it is relaxed for this one route only.
  const widgetSource = loadWidgetSource();
  if (widgetSource) {
    app.get("/widget/chat-widget.js", (_req, res) => {
      res.set({
        "Content-Type": "application/javascript; charset=utf-8",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control": "public, max-age=300",
      });
      res.send(widgetSource);
    });
  }

  // Small body limit: chat messages are short. Rejects oversized payloads early.
  app.use(express.json({ limit: "10kb" }));

  if (chat) app.use("/v1/chat", createChatRouter(env, chat.service));

  if (accounts) {
    const auth = new AuthService(accounts, env, logger, clock);
    const admin = new TenantAdminService(accounts, { allowInsecureLocalhostOrigins: env.NODE_ENV !== "production" }, clock);
    app.use("/v1", createV1Router({ env, store: accounts, auth, admin, ...(catalog ? { catalog } : {}), ...(knowledge ? { knowledge } : {}), ...(usage ? { usage } : {}) }));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
