# Data model & tenant isolation (Step 2)

## Rules
1. Every tenant-owned document has `restaurantId`. The server decides it (widget key -> `TenantResolver`); clients and the AI never supply it.
2. Application code never touches raw collections. It uses `repositories.forTenant(restaurant)`, which binds a `ScopedCollection` to one tenant. ESLint fails the build if `.collection()`, `mongodb` or `db/collections` are used outside `src/db`, `src/repositories`, `src/scripts`, `src/domain`.
3. `ScopedCollection` injects `{restaurantId}` in a separate `$and` clause, rejects caller-supplied `restaurantId`, forbids `$where/$function/$lookup/$unionWith/$out/...`, makes `restaurantId` immutable, requires a bounded `limit` (max 100) and prepends a tenant `$match` to every aggregation.
4. MongoDB `$jsonSchema` validators (strict, action=error) enforce tenant id format, integer prices, enums and message length even if the app layer is bypassed.
5. All indexes start with `restaurantId`, except `widgetKeys.publicKey` (it is how the tenant is discovered).

## Collections
| Collection | Key indexes | Retention |
|---|---|---|
| restaurants | `restaurantId` (unique), `slug` (unique) | - |
| widgetKeys | `publicKey` (unique), `{restaurantId,status}` | - |
| menuItems | `{restaurantId,slug}` (unique), `{restaurantId,nameNormalized}`, `{restaurantId,status,category}` | - |
| openingHours | `restaurantId` (unique) | - |
| faqs | `{restaurantId,slug}` (unique), `{restaurantId,status,slug}` | - (staff-authored content) |
| policies | `{restaurantId,kind}` (unique) | - (staff-authored content) |
| conversations | `{restaurantId,sessionTokenHash}` (unique), `{restaurantId,createdAt}`, TTL `expiresAt` | default 90 d, extended on activity |
| messages | `{restaurantId,conversationId,createdAt}`, TTL `expiresAt` | default 30 d |
| usageLogs | `{restaurantId,createdAt}`, `{restaurantId,conversationId}`, TTL `expiresAt` | default 13 months |
| users | `userId` unique, `email` unique | account lifecycle |
| memberships | `{userId,restaurantId}` unique, `{restaurantId,status}` | tenant access |
| sessions | `tokenHash` unique, `userId/createdAt`, TTL `expiresAt` | user sessions |
| plans | `code` unique | platform catalog |
| subscriptions | `restaurantId` unique, provider subscription id | SaaS billing state |
| apiKeys | `keyHash` unique, `{restaurantId,status}` | integrations |
| auditLogs | `{restaurantId,createdAt}` | tenant audit trail |

Retention defaults come from env; each restaurant may override them (`restaurants.retention`).

## Deliberate decisions
- **Money is integer.** Prices use `priceCents`; AI cost uses `estimatedCostMicros` (1e-6 USD) instead of the float in the original spec (`0.012`).
- **Allergens:** `toAllergenView()` returns nothing for unverified items. Verified data requires `allergensVerifiedAt` + `allergensVerifiedBy`. An empty allergen list never means "safe".
- **Knowledge base:** FAQs and policies are `draft` until published; the assistant's repository interface can only read `published`. See `docs/knowledge-api.md`.
- **Session tokens:** 256-bit random, only the SHA-256 is stored, lookup is tenant-scoped.
- **Widget keys** are public identifiers with an exact-origin allow-list (enforced in Step 3). They are not authentication.
- **Migrations** are append-only (`src/db/migrations`), applied by `npm run db:migrate` in the deploy pipeline. The API refuses to boot against an un-migrated database.

## Known limitations (scheduled)
- Conversation append is two writes (no multi-document transaction; Atlas supports them if needed later).
- In-memory rate limiting is per container; a shared store arrives in Step 3.
- TTL deletion runs about every 60 s; it is a retention guarantee, not an instant delete.


## Migration IDs
Migrations use explicit immutable IDs (`001_initial_schema`, `002_saas_foundation`). Never derive migration identity from JavaScript module names or object properties that may be undefined. Once a migration has shipped, add a new migration instead of editing its behavior.
