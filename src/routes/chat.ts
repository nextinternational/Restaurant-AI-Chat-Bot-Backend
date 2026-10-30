import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { Env } from "../config/env.js";
import { hashToken } from "../security/tokens.js";
import { originAllowed, type ChatService } from "../services/chat/chatService.js";

const limited: RequestHandler = (req, res) => {
  res.status(429).json({ error: { code: "rate_limited", message: "Too many messages, slow down a little", requestId: req.id } });
};

function bearer(header: string | undefined): string | undefined {
  const m = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
  return m?.[1];
}

/**
 * Public widget API. The restaurant is NEVER taken from the request body: the widget key in the path
 * identifies the widget, the server resolves the tenant from it and checks the Origin against that key's
 * allow-list. The session token (Authorization header) then proves which conversation this is.
 */
export function createChatRouter(env: Env, service: ChatService): Router {
  const router = Router();
  const keyed = Router({ mergeParams: true });

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Per-tenant CORS: answers the browser preflight and echoes the Origin only when this key allows it.
  keyed.use(async (req, res, next) => {
    const origin = req.headers.origin;
    const resolved = await service.resolveKey(req.params.widgetKey);
    const ok = resolved !== null && originAllowed(resolved.allowedOrigins, origin);
    if (ok && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!ok) {
        res.status(403).end();
        return;
      }
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  });

  const hour = 60 * 60_000;
  const base = { standardHeaders: "draft-7", legacyHeaders: false, handler: limited } as const;
  const sessionsPerIp = rateLimit({ ...base, windowMs: hour, limit: env.CHAT_SESSIONS_PER_IP_HOUR });
  const sessionsPerKey = rateLimit({ ...base, windowMs: hour, limit: env.CHAT_SESSIONS_PER_KEY_HOUR, keyGenerator: (req) => `s:${String(req.params.widgetKey).slice(0, 64)}` });
  const messagesPerSession = rateLimit({
    ...base, windowMs: 60_000, limit: env.CHAT_MESSAGES_PER_SESSION_MIN,
    keyGenerator: (req) => `m:${hashToken(bearer(req.headers.authorization) ?? "-")}`,
  });
  const messagesPerKey = rateLimit({ ...base, windowMs: 60_000, limit: env.CHAT_MESSAGES_PER_KEY_MIN, keyGenerator: (req) => `k:${String(req.params.widgetKey).slice(0, 64)}` });

  keyed.post("/sessions", sessionsPerIp, sessionsPerKey, async (req, res) => {
    const session = await service.startSession(req.params.widgetKey, req.headers.origin);
    res.status(201).json(session);
  });

  keyed.post("/messages", messagesPerSession, messagesPerKey, async (req, res) => {
    const reply = await service.sendMessage(req.params.widgetKey, req.headers.origin, bearer(req.headers.authorization), req.body);
    res.json(reply);
  });

  router.use("/:widgetKey", keyed);
  return router;
}
