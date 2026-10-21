# Restaurant AI Platform

Multi-tenant AI customer-service backend for a fixed set of restaurants. Each restaurant embeds a chat widget on its own
WordPress/Elementor site; all restaurants share one Node.js backend, and every restaurant's data is isolated from the others.

**Stack:** Node.js 22 · Express 5 · TypeScript · MongoDB Atlas · OpenAI · AWS (ECS Fargate).

## How it works

1. **The widget identifies the restaurant, the server decides the tenant.** The widget key (public) is resolved to a `restaurantId` on the server and checked against the key's allowed origins. The `restaurantId` never comes from the customer or from the AI.
2. **MongoDB is the source of truth.** Prices, opening hours, menu items, allergen data and location are read through tenant-scoped tools. The AI understands the question and phrases the answer; it does not invent facts.
3. **Code guards the answer.** Prices must come from a tool result in the same turn. Allergen answers need human-verified data. Otherwise the customer is not given a guess.
4. **When the assistant cannot help, the customer gets the restaurant's phone number.** This applies when the customer asks for a person or for the number, when the information is unverified, when the model is unsure, or when the AI budget is spent. There is no staff dashboard, live chat or notification channel. See `docs/chat-api.md`.

## Capabilities

| Area | What is included |
|---|---|
| Public chat API | Widget sessions, per-tenant CORS, tool-grounded answers, deterministic safety guards, contact-number replies (English/Arabic), usage and monthly budget enforcement. `docs/chat-api.md` |
| Catalog API | Menu, allergen-verification and opening-hours management for restaurant staff: role-gated and audited. `docs/catalog-api.md` |
| Knowledge base | FAQs and policies (cancellation, children, pets, payment, ...) written by staff, draft/publish lifecycle, quoted by the assistant only once published. `docs/knowledge-api.md` |
| Accounts and access | Login, revocable sessions, role-based permissions, widget-key management, audit trail. |
| Operator tooling | Restaurants, staff accounts and settings (address, contact phone, map link, AI budget) are created from the CLI; there is no public tenant creation. |
| Data layer | Tenant isolation through `ScopedCollection`, schema validators, integer money, TTL retention, hashed session tokens. `docs/data-model.md` |

**Not included (by design):** staff dashboard, live chat, handoff queue, staff notifications (Telegram/email), billing. Planned next: reservations.

> Plans, subscriptions and API-key tables from the early design are dormant: nothing in the product depends on them, there is no billing, and `POST /v1/auth/signup` is disabled unless `ALLOW_PUBLIC_SIGNUP=true`. See `docs/saas-architecture.md` and `docs/production-readiness.md` for the original, broader notes.

## Quick start

```bash
cp .env.example .env              # fill in MONGODB_URI etc.
docker compose up -d              # or any local MongoDB
npm ci
npm run db:migrate && npm run db:seed   # demo data; note the printed rest_001 widget key
OPENAI_API_KEY=sk-... npm run dev
```

Without `OPENAI_API_KEY` the public chat API is not mounted (the server logs a warning); the management API still works.

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server (needs `.env`, see `.env.example`) |
| `npm run typecheck` / `lint` / `test` | Quality gates (all run in CI); `npm run verify` runs all three |
| `npm run build && npm start` | Production build |
| `docker compose up --build` | Local API + MongoDB |
| `npm run db:migrate` | Apply schema migrations (validators + indexes). **Run it before deploying this version: migration 004 adds `faqs` and `policies`, and the API refuses to boot without it.** |
| `npm run db:seed` | Demo data: two restaurants, same item slug and FAQ/policy keys, different content (dev only) |
| `npm run test:integration` | Tenant-isolation tests against a real MongoDB (`MONGODB_TEST_URI`) |

## Onboarding a restaurant (operators only)

Restaurants and staff are created from the command line, not over HTTP. Passwords are never accepted as arguments: set `PROVISION_PASSWORD` or let the tool generate one (printed once). An existing email is attached to the new restaurant and keeps its password. In production use `npm run provision:prod -- ...` after `npm run build`.

```bash
# 1. Create the restaurant and its owner
npm run provision:restaurant -- --name "Harbor Grill" --timezone America/Antigua --currency XCD \
  --owner-email owner@example.com --owner-name "Owner" --origin https://harborgrill.example

# 2. Set the address and the contact phone number customers are given (required before going live)
npm run provision:settings -- --restaurant harbor-grill --address "1 Beach Road, St John's" \
  --phone "+1 268 555 0100" --monthly-ai-budget-usd 15

# 3. Optional: more staff who maintain the menu
npm run provision:staff -- --restaurant harbor-grill --email chef@example.com --name "Chef" --role manager
```

Menu items, allergen verification and opening hours are entered through the catalog API (`docs/catalog-api.md`); FAQs and policies through the knowledge API (`docs/knowledge-api.md`). **Allergen data and opening hours must be entered and verified by a person before the assistant can use them**; until then customers are given the restaurant's phone number instead.

## Chat widget

Local test: put the key printed by `db:seed` into `examples/widget-test.html`, run `python3 -m http.server 8080` in the repo root and open `http://localhost:8080/examples/widget-test.html`.

WordPress/Elementor: host `widget/chat-widget.js` on the site (or any static host) and add an HTML widget:

```html
<script src="/path/chat-widget.js" data-api="https://api.yourdomain.com" data-key="wk_..."
        data-title="Restaurant name" data-lang="en" data-color="#1f6feb" defer></script>
```

The site's exact origin (scheme + host + port) must be listed on the widget key. When the assistant gives the restaurant's number, the widget shows a tap-to-call button.

## Accounts and access API

Base path `/v1`. Auth is `Authorization: Bearer <token>` (no cookies, so no CSRF surface; the token is shown once and only its SHA-256 is stored).

| Endpoint | Permission | Purpose |
|---|---|---|
| `POST /v1/auth/login` | public (per-IP and per-account limits) | Returns a session and the user's restaurants |
| `POST /v1/auth/logout` / `logout-all` | any user | Revoke this session / every session |
| `GET /v1/me` | any user | Current user and restaurants with roles |
| `GET/PATCH /v1/restaurants/:id` | `restaurant:read` / `write` | Settings (name, timezone, locale only) |
| `GET /v1/restaurants/:id/team` | `team:read` | Members and roles |
| `GET /v1/restaurants/:id/audit-logs` | `audit:read` | Who changed what |
| `GET /v1/restaurants/:id/usage` | `usage:read` | AI requests, tokens and estimated cost: totals, per model, per conversation |
| `GET/POST/DELETE /v1/restaurants/:id/widget-keys` | `widgets:manage` | Public widget keys with allowed origins |
| `POST /v1/auth/signup` | **disabled by default** (`ALLOW_PUBLIC_SIGNUP=true`) | Creates user + restaurant + owner membership |

The `:id` in the URL is only a **claim**. `requireTenant` checks the caller's active membership and role on the server, returns 404 (not 403) for non-members, and only then binds the tenant to the request. See `src/middleware/auth.ts` and `src/auth/permissions.ts`.

## Security baseline

- Env validated at boot with Zod; the process refuses to start on bad config. Production rejects localhost DB and wildcard CORS.
- Helmet (strict CSP, HSTS in prod), no `X-Powered-By`, CORS deny-by-default, 10 KB body limit, global and per-endpoint rate limits.
- Tenant isolation is enforced by `ScopedCollection`, not by developer discipline; lint blocks raw collection access.
- Server-generated request IDs; structured logs with redaction of tokens and PII.
- Errors never leak stack traces; unknown errors become a generic 500.
- Container: multi-stage, non-root user, tini, healthcheck. CI: typecheck, lint (+ security plugin), tests, `npm audit`, gitleaks.

## AWS target

ALB (TLS, AWS WAF) -> ECS Fargate (private subnets) -> MongoDB Atlas via PrivateLink/VPC peering. Secrets in AWS Secrets Manager, logs in CloudWatch, images in ECR. `TRUST_PROXY_HOPS=1` behind the ALB. Use `/health/live` for container checks and `/health/ready` for the ALB target group. Infrastructure code is not part of this repository yet.

## Known limits

- No email verification, password reset or team invitations (would need an email provider).
- Rate limits are per container; use a shared store before running more than one task.
- Signup (when enabled) is not transactional on a single-node MongoDB; a failure rolls back best-effort.
- Existing databases keep the legacy `handoff` conversation status and `restaurants.notifications` field; the application no longer reads or writes them.
