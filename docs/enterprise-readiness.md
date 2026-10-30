# Enterprise readiness: honest assessment (v0.8.0)

This is a review of the code and deployment files, not a certification. "Verified" means checked by running it; "reviewed" means read but not run.

## What is solid
- **Tenant isolation** is enforced in code (`ScopedCollection` injects `restaurantId`, forbids cross-collection operators, lint-enforced boundary). The AI has no way to name a restaurant. *Reviewed; unit tests verified; real-database integration tests not run in this review.*
- **Answer safety**: prices, allergens and policies are checked by code after the model answers; failures give the restaurant's phone number. *Verified by tests, including the Arabic-numeral fix in 0.7.0.*
- **Security basics**: hashed session/widget tokens, scrypt passwords with constant-work login, strict CORS and per-tenant origin allow-lists, rate limits, redacted logs, non-root container, CI with CodeQL, audit and secret scanning.
- **Quality gates**: typecheck, lint with zero warnings, 243 unit tests.

## Known residual risks
| Risk | Detail | Mitigation today |
|---|---|---|
| Bare-number prices | The guard recognises amounts with a currency symbol, code or word. A reply like "It's 38." with no currency marker is not caught. | The prompt forbids stating unverified prices; add a "price words near a number" check if testing shows leaks. |
| Allergen/dietary labels | `dietaryLabels` (e.g. gluten_free) are staff tags, not allergen verification. | Allergy wording forces a verified allergen lookup. Since 0.8.0, halal/vegan/kosher/etc. claims must match a tag the menu tool returned, and pork/alcohol/gelatin claims must appear in the tool text; otherwise the phone number. Staff must still keep the tags correct. |
| Budget overshoot | The monthly budget is checked before the model call and recorded after, so concurrent requests can overshoot slightly. | Negligible at five restaurants; set the OpenAI account limit as the hard cap. |
| Single instance | Rate limits are in memory, so only one API container may run. One VPS is a single point of failure. | Acceptable for five restaurants; see roadmap. |

## Gaps to close for a larger company (priority order)
**Before the first live customer**
1. Run `npm run test:integration` against a real MongoDB, and test with the real OpenAI key in English and Arabic (including dialect and mixed-language messages).
2. Give restaurant staff a way to manage menus, hours and allergen verification. Today this is API-only; owners cannot realistically use it. Minimum: an admin web page or a spreadsheet/CSV import.
3. Replace the placeholder security email, publish the privacy notice on each site, agree retention periods.

**Before selling to larger customers**
4. High availability: Redis-backed rate limiting, two or more API instances behind a load balancer, managed deployment (the `alt-aws/` Terraform is a starting point; it has not been applied or tested in this review).
5. Staff identity: MFA (and SSO if the customer needs it), password reset and email verification (not built).
6. Observability: metrics (latency, error rate, AI cost, guard-override rate), dashboards, alert routing, tracing. Today there are structured logs and a health endpoint only.
7. A staging environment and an automated deploy pipeline with rollback.
8. External penetration test, load test, backup-restore drill, and the legal pack (DPA, terms, subprocessor list for OpenAI and MongoDB Atlas).

**Product roadmap (already planned)**
9. Reservations, with the rule that the AI may only say "confirmed" after the backend has created a confirmed reservation.
10. Analytics on questions asked and how often the bot hands off to the phone number, to find missing FAQ content.
