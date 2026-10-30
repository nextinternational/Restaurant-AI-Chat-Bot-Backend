# Operations runbook

Audience: the person running the platform day to day. Commands assume the VPS layout from `docs/go-live.md`.

## Daily / weekly
| Check | How | Expect |
|---|---|---|
| API alive | Uptime monitor on `https://api.<domain>/health/ready` (1-minute interval, alert by email/SMS) | 200 `{"status":"ok"}` |
| AI cost per restaurant | `GET /v1/restaurants/:id/usage` | Below each restaurant's monthly budget |
| Errors | `docker compose -f deploy/docker-compose.prod.yml logs --since 24h api \| grep '"level":50'` | None, or understood |
| Disk | `df -h` on the VPS | Under 80% |

## Alerts to configure (first week)
1. Readiness fails for 2 minutes.
2. OpenAI spend reaches 80% of the OpenAI dashboard limit.
3. A restaurant reaches 80% of its monthly AI budget (the bot then switches to the phone number at 100%).
4. VPS disk above 85%, or the Atlas cluster reports connection errors.

## Backups and restore
- Atlas: enable backups (continuous on M10+). **Do a test restore into a scratch cluster once, before launch, and again every quarter.**
- VPS: enable the GoDaddy snapshot option. The VPS holds no data of record (MongoDB Atlas does), so it can be rebuilt from the repo plus `deploy/.env*` files; keep an encrypted copy of those two files outside the server.

## Releases
1. Merge to `main` only when CI is green (typecheck, lint, unit + integration tests, audit, CodeQL, secret scan).
2. On the VPS: upload the new code, run `./deploy/deploy.sh` (it migrates the database first, then restarts, then checks health).
3. If the health check fails: restore the previous code folder and run `./deploy/deploy.sh` again. Migrations are additive; they do not need reverting.

## Secrets and rotation
| Secret | Where | Rotate |
|---|---|---|
| OpenAI key | `deploy/.env.production` | Every 90 days, or immediately if exposed |
| MongoDB user password | `deploy/.env.production` and Atlas | Every 90 days |
| Widget key | Created per restaurant through the API | Immediately if a site is compromised; revoke the old key, create a new one, update the site |
| Staff passwords | Set at provisioning | On staff change; revoke sessions on departure |

After rotating: `./deploy/deploy.sh` (restarts the API with the new values).

## Incident playbook
- **The bot gave a wrong price or allergen answer.** (1) Get the conversation id from the customer or the logs. (2) Check the menu data for that item: is the price right, are the allergens marked verified? Fix the data. (3) If the data was right and the bot still answered wrongly, treat it as a guard defect: revoke that restaurant's widget key to stop the chat, then fix, add a regression test, deploy. (4) Tell the restaurant what happened.
- **Suspected key or data exposure.** Revoke the affected widget key(s) and rotate the OpenAI and MongoDB secrets. Check the audit log for staff actions. Notify the affected restaurant(s) and, if customer data is involved, follow your legal notification duties.
- **OpenAI outage.** Customers receive a short "temporarily unavailable" message (503); nothing else breaks. No action needed beyond monitoring.
- **MongoDB outage.** Readiness fails and the chat stops. Check the Atlas status page and the network access list (the VPS IP must be allowed).

## Onboarding checklist (per restaurant)
- [ ] Restaurant provisioned; owner account created; phone number and address set.
- [ ] Menu entered; every dish with allergens entered **and verified by a person**.
- [ ] Opening hours entered (including holiday exceptions) and verified.
- [ ] Policies and FAQs published (cancellation, children, pets, payment, delivery, ...).
- [ ] Widget key created with the exact site origin(s), including or excluding `www` as the site actually uses.
- [ ] The five test questions from `docs/go-live.md` pass, including Arabic.
- [ ] Privacy notice about the chat and retention published on the site.
- [ ] Monthly AI budget agreed and set.
