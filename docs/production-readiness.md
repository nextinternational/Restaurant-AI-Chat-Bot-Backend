# Production readiness review

> **Scope note (Step 6):** the product is a custom AI customer-service platform for a fixed set of restaurants, not a commercial SaaS.
> Sections about plans, subscriptions, billing providers and self-service signup describe the original broader design and are **not on the roadmap**; they are kept for reference.

## Current assessment

### Strong
- TypeScript strict mode.
- Express 5.
- Zod validation.
- MongoDB validators.
- Tenant-bound repository layer.
- Tenant-isolation tests.
- Hashed high-entropy session/widget tokens.
- Integer money representation.
- Verified-only allergen exposure.
- TTL retention.
- Security headers.
- Request IDs.
- Redacted structured logs.
- Graceful shutdown.
- Non-root production container.
- CI, CodeQL, Dependabot and secret scanning.

### Needs implementation before commercial launch
- Human authentication and account lifecycle.
- Email verification and password reset.
- RBAC middleware and permission checks.
- Restaurant onboarding and invitations.
- Billing provider integration and webhook idempotency.
- Plan/feature enforcement at request time.
- Distributed rate limiting across multiple containers.
- AI provider abstraction and retry/circuit-breaker policy.
- AI cost enforcement against the monthly restaurant budget.
- Public widget API and frontend.
- Abuse/spam protection for public chat.
- Audit-event generation from real privileged actions.
- Data export/deletion workflows.
- Observability dashboards and alerting.
- Backup restore drills.
- Load tests and failure-mode tests.
- Privacy policy, terms, DPA and retention documentation.

## Important architectural decision

Do not turn the project into one giant Express controller.

Use:

```text
routes -> auth/tenant middleware -> services -> repositories -> MongoDB
                                  |
                                  +-> AI tools
                                  +-> billing
                                  +-> audit
```

Controllers should validate input and coordinate services. Business rules belong in services. Database access belongs in repositories.

## Definition of "professional"

A professional SaaS is not just a secure database.

It must be:
- secure;
- observable;
- recoverable;
- testable;
- operable by staff;
- understandable by customers;
- monetizable;
- resistant to abuse;
- capable of supporting multiple tenants without code duplication.

The current project has a very good foundation for these goals, but the application/product layer still has to be built.


## Step 4 status (accounts & access)
Done: signup/onboarding, login, logout, logout-all, session expiry, role permissions, tenant admin API, widget-key management, audit entries, brute-force limits, constant-time login, async password hashing.
Still required before commercial launch: email verification, password reset, team invitations, MFA for owners, shared rate-limit store, enforced plan quotas, billing provider, terms/privacy/DPA.


## Step 8 status (knowledge base)
Done: FAQ and policy collections with validators and tenant-prefixed indexes, draft/publish lifecycle, management API with roles and audit, `search_faq` / `get_policy` tools over published content only, policy-topic guard, tests (rules, API, AI layer, tenant isolation) and a real-MongoDB integration test.
Still to do: semantic search (RAG) if keyword retrieval proves too narrow in production transcripts; per-language entries; reservations (next step).
