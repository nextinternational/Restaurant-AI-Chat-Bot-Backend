# SaaS architecture

> **Scope note:** the product is a custom AI customer-service platform for a fixed set of restaurants, not a commercial SaaS.
> Sections about plans, subscriptions, billing providers, self-service signup and any web dashboard describe the original broader design and are **not on the roadmap**; they are kept for reference.
> Customers who need a person are given the restaurant's phone number; there is no staff dashboard, live chat or notification channel.

## The mental model

This product is a **multi-tenant SaaS platform for restaurants**.

- **Platform** = your company and its global configuration.
- **User** = a person who logs into the SaaS.
- **Restaurant** = a tenant/customer account.
- **Membership** = the relationship between a user and a restaurant.
- **Widget key** = the public identifier embedded in a restaurant website.
- **API key** = a server-to-server credential for integrations; it is never the same thing as a widget key.
- **Plan** = what the platform sells.
- **Subscription** = the plan currently attached to one restaurant.
- **Usage** = how much AI/service capacity that restaurant consumed.
- **Audit log** = the security/business history of important actions.

## Why restaurant is the tenant

A single company account may manage several restaurants:

```text
User
 ├── Membership -> Restaurant A
 ├── Membership -> Restaurant B
 └── Membership -> Restaurant C
```

Data belonging to Restaurant A must never be returned while operating in Restaurant B.

That is why the existing `ScopedCollection` remains the most important security boundary.

## Product layers

```text
API clients (CLI, scripts)
          |
          v
      API v1
          |
   Authentication
          |
   Membership / RBAC
          |
     Tenant context
          |
  -----------------------
  |         |           |
 Menu    Conversations  Usage
  |         |           |
  -------- MongoDB ------
          |
    AI orchestration
          |
   provider(s) + tools
          |
      restaurant
```

## Commercial SaaS flow

1. User signs up.
2. A restaurant tenant is created.
3. The first user becomes `owner`.
4. The owner chooses a plan.
5. A subscription is created.
6. The owner configures menu, hours and widget.
7. The widget is embedded into the restaurant website.
8. Customers chat through the widget.
9. AI calls only tenant-scoped tools.
10. Usage is recorded.
11. Quotas/budget are enforced.
12. Billing provider webhooks update the subscription.

## RBAC

Recommended permissions:

| Role | Typical permissions |
|---|---|
| owner | billing, team, settings, everything |
| admin | restaurant settings, menu, conversations, team |
| manager | menu, conversations, operations |
| staff | conversations and operational tasks |
| viewer | read-only analytics/config |

Do not check role strings throughout controllers. Add a central permission map such as `menu:write`, `billing:read`, `team:manage`, etc.

## Security boundaries

There are three different credential classes:

1. **User session** — authenticates a human.
2. **API key** — authenticates a trusted server/integration.
3. **Widget key** — identifies a public widget and is never treated as authentication.

The browser widget is public. Therefore it must have:
- strict origin allow-listing;
- per-tenant rate limits;
- per-session rate limits;
- abuse protection;
- message-size limits;
- no privileged operations.

## Billing rule

The database stores subscription state, but a payment provider remains the source of truth for payment events.

For production:
- create checkout/customer/subscription through the billing provider;
- verify webhook signatures;
- make webhook handling idempotent;
- store provider IDs;
- update local subscription state;
- never trust a browser request to mark a subscription as paid.

## AI rule

The model is **not** a tenant boundary.

The server must resolve the restaurant before constructing AI tools/context. The model should never be allowed to provide `restaurantId` and have that value become authoritative.

For every AI tool:
- receive server-bound tenant context;
- query only through tenant repositories;
- return only approved fields;
- record usage;
- stop when budget/quota is exceeded;
- hand off when information is uncertain or safety-sensitive.

## Production completion gates

Before selling this product:
- authentication and password recovery;
- email verification;
- RBAC enforcement;
- tenant onboarding;
- billing + verified webhooks;
- distributed rate limiting;
- AI provider abstraction;
- AI budget enforcement;
- widget frontend;
- audit events for privileged actions;
- backups/restore tests;
- monitoring and alerts;
- privacy/terms/DPA documents;
- load and abuse testing.
