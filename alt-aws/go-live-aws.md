# Go-live runbook (AWS ECS Fargate + MongoDB Atlas)

Target: `https://api.<yourdomain>` serving the five restaurants. Order matters; each phase ends with a check.

## Phase 0 - Accounts and decisions
- [ ] AWS account with billing alerts on; an admin user with MFA (not root).
- [ ] MongoDB Atlas cluster (M10+ recommended for production backups), database user with **readWrite on `restaurant_ai` only**.
- [ ] OpenAI API key with a **monthly spend limit** set in the OpenAI dashboard (second layer after the per-restaurant budget).
- [ ] DNS host for `api.<yourdomain>` (any provider; you only need to add CNAME records).
- [ ] Replace `security@your-company.example` in `SECURITY.md`.
- [ ] Verify model prices in `.env.example` (`AI_*_COST_MICROS_PER_MTOK`) against OpenAI's current price list; they drive the budget cap.

## Phase 1 - Infrastructure (Terraform, `infra/`)
```bash
cd infra && cp terraform.tfvars.example terraform.tfvars   # edit values
terraform init
terraform apply -target=aws_ecr_repository.api -target=aws_acm_certificate.api
terraform output acm_validation_records    # add these CNAMEs at your DNS host, wait until the cert is ISSUED
```
Push a first image (tags are immutable, use a real tag):
```bash
aws ecr get-login-password | docker login --username AWS --password-stdin $(terraform output -raw ecr_repository_url | cut -d/ -f1)
docker build -t $(terraform output -raw ecr_repository_url):bootstrap .. && docker push $(terraform output -raw ecr_repository_url):bootstrap
```
Set the secrets (values never touch Terraform state):
```bash
aws secretsmanager put-secret-value --secret-id restaurant-ai-prod/MONGODB_URI --secret-string 'mongodb+srv://USER:PASS@cluster.mongodb.net/?retryWrites=true&w=majority'
aws secretsmanager put-secret-value --secret-id restaurant-ai-prod/OPENAI_API_KEY --secret-string 'sk-...'
```
In Atlas -> Network Access add **only** the IP from `terraform output nat_static_ip`.
Then `terraform apply` (full; set `image_tag = "bootstrap"`), and create the DNS record `api.<yourdomain>` -> `terraform output alb_dns_name` (CNAME).

**Check:** the service shows 1 running task; the first start fails until the migration in Phase 2 has run.

## Phase 2 - Database migration and first release
Run the migration once (also done automatically by every deploy):
```bash
aws ecs run-task --cluster restaurant-ai-prod --launch-type FARGATE --task-definition restaurant-ai-prod-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw task_security_group_id)],assignPublicIp=DISABLED}"
```
Wire GitHub Actions (repo -> Settings): secret `AWS_DEPLOY_ROLE_ARN` (an IAM role trusting GitHub OIDC with ECR push, ECS register/run/update, `iam:PassRole` on the two ECS roles); variables `AWS_REGION`, `PRIVATE_SUBNET_IDS` (comma separated), `TASK_SECURITY_GROUP_ID`, `API_DOMAIN`. Create a `production` environment with a required reviewer, then run **Deploy**.

**Check:** `curl https://api.<yourdomain>/health/ready` -> `{"status":"ok"}` and `curl -I https://api.<yourdomain>/widget/chat-widget.js` -> 200.

## Phase 3 - Onboard each restaurant (repeat x5)
Use one-off ECS tasks with a command override (production reaches Atlas only from inside the VPC):
```bash
# example: restaurant + owner (PROVISION_PASSWORD omitted -> a password is generated and printed once in CloudWatch Logs)
aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"migrate","command":["node","dist/scripts/provision.js","restaurant","--name","Harbor Grill","--timezone","America/Antigua","--currency","XCD","--owner-email","owner@x.com","--owner-name","Owner","--origin","https://harborgrill.com"]}]}'
# then: settings (phone is REQUIRED), see README "Onboarding a restaurant"
```
Then, through the catalog/knowledge APIs, the restaurant enters menu, opening hours and FAQs/policies and a person **verifies allergens and hours**.
Create the widget key (`POST /v1/restaurants/:id/widget-keys`) with the exact site origin(s): scheme + host, `https://www.` and apex are different origins.

**Check per restaurant (must all pass before step 4):** phone set; hours verified; at least the main menu items entered; allergens verified or intentionally left unverified; widget key origin matches the live site.

## Phase 4 - Add the widget in WordPress/Elementor
Elementor -> add an **HTML** widget in the site footer (or the Elementor Pro Theme Builder footer so it shows on every page):
```html
<script src="https://api.<yourdomain>/widget/chat-widget.js"
        data-api="https://api.<yourdomain>" data-key="wk_..." data-title="Restaurant name" defer></script>
```
Test on the live site with: price question, "are you open tomorrow?", an allergy question (must give the phone number), "can I talk to someone?", and one in Arabic.

## Phase 5 - Operate
- Alarms email you for unhealthy targets, 5xx bursts and zero running tasks (confirm the SNS subscription email).
- Costs: `GET /v1/restaurants/:id/usage`; the budget cap stops the AI and shows the phone number instead.
- Keep **`desired_count = 1`** until rate limiting uses a shared store (README, Known limits).
- Rollback: ECS circuit breaker rolls back failed deploys automatically; for a bad-but-healthy release, re-run Deploy on the previous commit. Migrations are additive.
- Atlas: enable continuous backup and do one restore drill before launch.
- Before announcing publicly: privacy notice on each site mentioning the chat and the retention periods (30 days messages / 90 days conversations by default).
