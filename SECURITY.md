# Security policy

## Reporting a vulnerability
Email security@your-company.example (do not open a public issue). We acknowledge within 2 business days.

> **Before going live:** replace the placeholder address above with a monitored mailbox owned by the company.

## Engineering controls
- Tenant isolation enforced in code (`ScopedCollection`), lint-enforced boundary, DB-level validators, integration tests against a real MongoDB.
- The restaurant is never taken from the customer or the AI: the widget key resolves to a tenant on the server, and the Origin is checked against that key's allow-list.
- Prices, allergens and policies are checked by code after the model answers; an ungrounded value is replaced by the restaurant's phone number (English and Arabic numerals both covered).
- Session tokens and widget keys are high-entropy and only their hashes are stored. Passwords use scrypt with a timing-safe, constant-work login path.
- Strict env validation; production requires TLS to MongoDB, no wildcard CORS, trusted-proxy configuration.
- No secrets in the repo (gitleaks in CI). On the VPS deployment, production secrets live in `deploy/.env.production` (mode 600, never committed). On the optional AWS deployment (`alt-aws/`) they live in AWS Secrets Manager.
- CI gates: typecheck, lint (+ eslint-plugin-security, zero warnings), unit and integration tests, `npm audit`, CodeQL, Dependabot.
- Containers run as non-root, multi-stage, without install scripts.

## Known limits
See `docs/enterprise-readiness.md` for what is deliberately not covered yet (single instance, no MFA, no admin UI, no external penetration test).
