# Go-live on a GoDaddy VPS (Docker + Caddy + MongoDB Atlas)

Why a VPS: the API is a long-running Node 22 / Express 5 server. GoDaddy shared (cPanel) hosting is meant for PHP/WordPress and is not suitable for this. Keep the five WordPress sites where they are; only the API goes on the VPS.

## 1. Prepare (once)
- GoDaddy **VPS** (Ubuntu 22.04/24.04, 2 GB RAM is enough to start). Note its public IP.
- **MongoDB Atlas** cluster (the app requires a TLS MongoDB; localhost is rejected in production). DB user with readWrite on `restaurant_ai` only. In Network Access allow **the VPS IP only**.
- **OpenAI** key, with a monthly spend limit in the OpenAI dashboard.
- **DNS** (GoDaddy DNS): add an `A` record `api` -> VPS IP (so `api.yourdomain.com`). Wait until it resolves.

## 2. Server setup (SSH as root, once)
```bash
apt update && apt -y upgrade
adduser deploy && usermod -aG sudo deploy
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```
Also disable SSH password login (use keys) and enable GoDaddy's snapshot/backup option for the VPS.

## 3. Deploy
```bash
# as user "deploy": copy the project to the server (git clone, or scp the zip and unzip)
cd restaurant-ai-platform
cp deploy/.env.example deploy/.env                       # set API_DOMAIN
cp deploy/.env.production.example deploy/.env.production # fill MONGODB_URI, OPENAI_API_KEY
chmod 600 deploy/.env.production
./deploy/deploy.sh
```
Expected: `{"status":"ok"}` then `OK: API is live`. Caddy gets the HTTPS certificate automatically on first request.
Updates later: upload the new code and run `./deploy/deploy.sh` again (it migrates first).

## 4. Onboard each restaurant (repeat x5)
```bash
cd deploy
docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/provision.js restaurant \
  --name "Restaurant Name" --timezone America/Antigua --currency XCD \
  --owner-email owner@example.com --owner-name "Owner" --origin https://restaurant-site.com
docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/provision.js settings \
  --restaurant restaurant-name --address "Street, City" --phone "+1 268 555 0100" --monthly-ai-budget-usd 15
```
(The owner password is printed once; or set `PROVISION_PASSWORD`.) The restaurant then enters menu, hours, FAQs/policies through the API (`docs/catalog-api.md`, `docs/knowledge-api.md`); a person must **verify allergens and hours**. Create the widget key with the exact site origin (`https://www.site.com` and `https://site.com` are different).

## 5. Add the chat to each WordPress/Elementor site
Elementor -> **HTML** widget in the footer (or Theme Builder footer for all pages):
```html
<script src="https://api.yourdomain.com/widget/chat-widget.js"
        data-api="https://api.yourdomain.com" data-key="wk_..." data-title="Restaurant name"
        data-lang="en" data-color="#1f6feb" defer></script>
```
Use `data-lang="ar"` for an Arabic site (right-to-left layout) and `data-color` for the restaurant's brand colour (`#rrggbb`).
Test: a price, "are you open tomorrow?", an allergy question (must give the phone number), "can I talk to someone?", and one message in Arabic.

## 6. Operate
- Logs: `docker compose -f deploy/docker-compose.prod.yml logs -f api`
- Monitoring: add a free uptime check (e.g. UptimeRobot) on `https://api.yourdomain.com/health/ready`.
- Costs per restaurant: `GET /v1/restaurants/:id/usage`; the budget cap makes the bot show the phone number when spent.
- Run one API container only (rate limits are in-memory per container).
- Atlas: enable backups (M10+ for continuous) and test a restore once.
- Put a privacy notice on each site about the chat and retention (30 days messages / 90 days conversations by default).
