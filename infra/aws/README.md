# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK. DNS and domain managed by Cloudflare.

## Estimated cost

| Item | Cost | Why |
|---|---|---|
| Domain (`.com`, Cloudflare) | ~$10/year | Custom domain for the app (`app.yourdomain.com`) |
| ECS Fargate (0.5 vCPU / 1 GB ARM64, 24/7) | ~$13/month | Runs Next.js web app container |
| RDS t4g.micro (24/7) | ~$12/month | Managed Postgres with automated backups, private subnet isolation |
| NAT instance t4g.micro | ~$6/month | Outbound internet for ECS (ECR pulls) and Lambda in private subnet |
| ALB | ~$16/month | HTTPS termination with Origin Certificate, health checks |
| S3, CloudWatch, WAF, Lambda | ~$3/month | Access logs (S3), container and alarm monitoring (CloudWatch), rate limiting and SQLi/XSS protection (WAF), daily FX rate fetching (Lambda) |
| API Gateway (REST API) + Lambda | ~$0/month | SQL API for machine clients with per-key rate limiting; REST API pricing ($3.50/M requests) is negligible at low volume |
| **Total** | **~$10/year + ~$50/month** | |

Cloudflare (DNS, CDN, DDoS, edge SSL) is free. All prices are approximate for `eu-central-1` and may vary.

## Prerequisites

Verify that all required tools are installed:

```bash
aws --version       # AWS CLI v2+
node --version      # Node.js 24+
npx cdk --version   # AWS CDK CLI 2.100+
```

If anything is missing:

- **AWS CLI v2**: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
- **Node.js 24**: https://nodejs.org/en/download
- **CDK CLI**: `npm install -g aws-cdk`

## Architecture

```
Browser → Cloudflare (CDN + DDoS + edge SSL) → ALB (Origin Cert) → ECS Fargate → RDS
                                                  │                      ↓
                                                  │                Lambda (FX rates)
                                                  │
                                                  ├─ domain.com ──────▶ 302 redirect to app.*
                                                  └─ app.* ───────────▶ web:8080 (Cognito Email OTP)

Machine → Cloudflare → API Gateway (REST API) → Lambda Authorizer → SQL Lambda → RDS
                         │
                         └─ api.* ──────────▶ POST /v1/sql (ebt_ Bearer token auth)
```

**Cloudflare** handles domain registration, DNS, CDN caching, DDoS protection, and edge TLS.
**AWS** handles compute, database, auth, monitoring, and application logic.

## What gets created

**On AWS (via CDK):**

- **VPC** with public and private subnets (2 AZs, 1 NAT instance — t4g.micro for cost savings)
- **RDS Postgres 18** (t4g.micro) in private subnet, credentials in Secrets Manager
- **Secrets Manager** — DB credentials (auto-generated), app DB password, OpenAI API key, Anthropic API key
- **ECR** — two repositories (`expense-tracker/web`, `expense-tracker/migrate`), images built in CI
- **ECS Fargate** — web service (0.5 vCPU / 1 GB ARM64, 1–3 tasks, CPU-based auto-scaling with alert on scale-out) + one-off migration task definition
- **ALB** with HTTPS (Cloudflare Origin Certificate), forwards traffic to ECS
- **Cognito User Pool** (Essentials tier) — passwordless Email OTP auth, managed by the app directly (no Hosted UI)
- **AWS WAF** on ALB — SQLi/XSS protection, common threat rules (rate limiting handled by Cloudflare)
- **Lambda** (Node.js 24) for daily FX rate fetching + EventBridge schedule at 08:00 UTC
- **API Gateway** (REST API) + two Lambdas (authorizer + SQL executor) for machine client SQL API; per-key rate limiting via Usage Plans, 5-min auth cache
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, API Gateway 5xx, ECS CPU/memory, ECS scale-out, DB connections, DB storage, Lambda errors
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — ECS web container logs `/expense-tracker/web` (30-day retention), migration logs `/expense-tracker/migrate`, Lambda logs (automatic)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy (ECR push + ECS deploy)

**On Cloudflare (via scripts):**

- Domain registration
- DNS CNAME `@` root domain (proxied) pointing to ALB — redirects to `app.*`
- DNS CNAME `app.*` (proxied) pointing to ALB — authenticated app
- Origin Certificate for ALB HTTPS (imported into ACM)
- Cache bypass rule for `app.*` and root domain (fully dynamic app, no edge caching benefit)
- Edge SSL, DDoS protection (automatic with proxied DNS)

## Step-by-step setup

### 1. Create a dedicated AWS account

Create a **new, dedicated AWS account** for this project. Do not deploy into an existing account with other workloads — it makes resources hard to find, billing hard to track, and cleanup hard to do safely. One account per project = clean isolation of resources, billing, and IAM.

Recommended account name: **`expense-budget-tracker`**.

If you use AWS Organizations (multiple accounts under one payer):

```bash
# Enable Organizations in your main (payer) account (once)
aws organizations create-organization

# Create a member account for the tracker
# Use a unique email — Gmail/Workspace "+" aliases work: you+expense@gmail.com
aws organizations create-account \
  --email you+expense-budget-tracker@gmail.com \
  --account-name "expense-budget-tracker"

# Check creation status (wait until State is SUCCEEDED)
aws organizations list-accounts \
  --query "Accounts[?Name=='expense-budget-tracker']"
```

Save the **Account ID** (12-digit number) — you need it in the next step.

### 2. Configure CLI profile

**Option A — Organizations cross-account role** (if you created a member account in step 1):

Add a named profile to `~/.aws/config`:

```ini
[profile expense-tracker]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/OrganizationAccountAccessRole
source_profile = default
region = eu-central-1
```

**Option B — Standalone account with SSO or IAM credentials**:

```ini
[profile expense-tracker]
region = eu-central-1
# Add your auth method: sso-session, access keys, etc.
```

Verify the profile works:

```bash
aws sts get-caller-identity --profile expense-tracker
```

### 3. Register domain and set up Cloudflare

Domain and DNS are managed by Cloudflare. Cloudflare provides free CDN, DDoS protection, and edge SSL on top of DNS. No Cloudflare CLI is needed — only the dashboard (for domain registration) and API calls via `curl` (for everything else).

#### 3a. Register domain (dashboard — one time)

Domain registration is only available through the Cloudflare web UI:

1. Go to https://dash.cloudflare.com/ and log in (or create an account).
2. **Domain Registration** → **Register Domain** → search for your domain and purchase it.
   Cloudflare sells domains at cost (no markup).

#### 3b. Create API token (dashboard — one time)

Go to https://dash.cloudflare.com/profile/api-tokens → **Create Token**:

- Template: **"Edit zone DNS"**
- Zone Resources: Include → Specific zone → your domain
- **Important:** click "+ Add more" and add three more permissions:
  - **Zone → SSL and Certificates → Edit** (for Origin Certificate creation)
  - **Zone → Zone Settings → Edit** (for setting SSL mode to Full Strict)
  - **Zone → Cache Rules → Edit** (for disabling edge cache on the app subdomain)

The token needs all four permissions (DNS + SSL + Zone Settings + Cache Rules). Missing any will cause script failures.

Copy the token and save it in your password manager along with the Zone ID from step 3c.

#### 3c. Verify token and find Zone ID (terminal)

Set the API token:

```bash
export CLOUDFLARE_API_TOKEN="<paste-your-api-token-here>"
```

Verify the token works:

```bash
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | python3 -m json.tool
```

Expected: `"status": "active"`.

Find your Zone ID (replace `yourdomain.com` with your domain):

```bash
curl -s "https://api.cloudflare.com/client/v4/zones?name=yourdomain.com" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | python3 -c '
import sys, json
for z in json.load(sys.stdin)["result"]:
    print(f"Zone: {z["name"]}  ID: {z["id"]}  Status: {z["status"]}")
'
```

Copy the **Zone ID** from the output and set it:

```bash
export CLOUDFLARE_ZONE_ID="<zone-id-from-output>"
```

#### 3c′. Save Cloudflare credentials for future use

Copy the example env file and fill in both values you just obtained:

```bash
cp scripts/cloudflare/.env.example scripts/cloudflare/.env
```

Edit `scripts/cloudflare/.env`:

```dotenv
CLOUDFLARE_API_TOKEN=<paste-your-api-token-here>
CLOUDFLARE_ZONE_ID=<paste-your-zone-id-here>
```

This file is gitignored. All subsequent steps can load it instead of re-exporting:

```bash
set -a; source scripts/cloudflare/.env; set +a
```

#### 3d. Create Origin Certificate and import into ACM (terminal)

```bash
set -a; source scripts/cloudflare/.env; set +a
export AWS_PROFILE=expense-tracker

bash scripts/cloudflare/setup-certificate.sh \
  --domain yourdomain.com \
  --region eu-central-1
```

The script creates a Cloudflare Origin Certificate (15-year, wildcard) via the API and imports it into AWS ACM. It prints the **certificate ARN** — you need this for step 4.

> **Why Origin Certificate?** Cloudflare Origin Certificates are free, long-lived (15 years), and trusted by Cloudflare's edge servers. Since all traffic flows through Cloudflare proxy, browsers see Cloudflare's edge certificate (Universal SSL, free). The Origin Certificate secures the connection between Cloudflare and your ALB.

#### 3e. Create API domain certificate (~5-30 min wait)

The SQL API for machine clients (LLM agents, scripts) uses a custom domain (`api.yourdomain.com`). This requires a public ACM certificate in your deployment region. API Gateway custom domains do not accept Cloudflare Origin Certificates — only publicly trusted certificates.

```bash
set -a; source scripts/cloudflare/.env; set +a
export AWS_PROFILE=expense-tracker

bash scripts/cloudflare/setup-api-domain.sh \
  --domain yourdomain.com \
  --region eu-central-1
```

The script requests the certificate, validates it via Cloudflare DNS, and waits for it to be issued. It prints the **API certificate ARN** — you need this for step 4.

> **Note:** The ACM validation CNAME record must stay in Cloudflare permanently — ACM needs it for automatic certificate renewal. Do not delete it.

### 4. Configure the stack

```bash
cd infra/aws
npm install
cp cdk.context.local.example.json cdk.context.local.json
```

Edit `cdk.context.local.json` with your values:

| Parameter | Description |
|---|---|
| `region` | AWS region, e.g. `eu-central-1` |
| `domainName` | Your domain, e.g. `myfinance.com` |
| `certificateArn` | ACM certificate ARN from step 3d (Cloudflare Origin Cert) |
| `apiCertificateArn` | ACM certificate ARN from step 3e (public cert for `api.myfinance.com`) |
| `alertEmail` | Email for CloudWatch alarm notifications |
| `githubRepo` | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |

#### Custom public site (optional)

By default, the root domain (`myfinance.com`) redirects to `app.myfinance.com` via an ALB rule — no extra container or code needed.

To serve your own site on the root domain, deploy it independently (Vercel, Cloudflare Pages, your own server, etc.) and update the Cloudflare DNS CNAME for `@` (root) to point to your site's hosting instead of the ALB. This repo does not manage the public site — they are fully independent.

### 5. Bootstrap and first deploy

```bash
export AWS_PROFILE=expense-tracker
bash scripts/bootstrap.sh --region eu-central-1  # ~15-20 min
```

The script handles the full first-time deployment:
1. `cdk bootstrap` (one-time CDK setup)
2. `cdk deploy` (creates VPC, RDS, ECR, ECS, ALB, etc.)
3. Builds and pushes Docker images (web + migrate) to ECR
4. `cdk deploy` again so ECS picks up the images

After this one-time bootstrap, all subsequent deploys happen automatically via CI/CD on push to `main`.

After deploy completes, **create the DNS record** pointing to the ALB and configure SSL:

```bash
set -a; source scripts/cloudflare/.env; set +a

bash scripts/cloudflare/setup-dns.sh \
  --stack-name ExpenseBudgetTracker
```

The script creates DNS CNAMEs for `app.*` and root domain (both proxied via Cloudflare), sets SSL/TLS to Full (Strict), and configures cache bypass.

### 6. Post-deploy

1. **Confirm SNS email** — check the `alertEmail` inbox for a message from "AWS Notifications" with subject "AWS Notification - Subscription Confirmation". Click the "Confirm subscription" link inside. Without this, CloudWatch alarm notifications will not be delivered
2. **Visit your domain** — Email OTP login page appears. Open registration: anyone can sign up with email. Each user gets an isolated workspace via RLS — no shared data between users
3. **Session encryption key** — CDK auto-generates a cryptographically random 32-byte hex key in Secrets Manager (`expense-tracker/session-encryption-key`). It encrypts the OTP session cookie (Cognito session + email + CSRF token) with AES-256-GCM during the login flow. Rotating this key invalidates only in-flight OTP sessions (users mid-login must request a new code). To rotate: `aws secretsmanager put-secret-value --secret-id expense-tracker/session-encryption-key --secret-string "$(openssl rand -hex 32)" --profile expense-tracker`, then restart the auth ECS service
4. **Set AI API keys (first deploy only)** — the AI chat feature requires OpenAI and/or Anthropic API keys. CDK creates placeholder secrets in AWS Secrets Manager on the first deploy; replace them with real keys once:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id expense-tracker/openai-api-key \
     --secret-string 'sk-...' \
     --profile expense-tracker

   aws secretsmanager put-secret-value \
     --secret-id expense-tracker/anthropic-api-key \
     --secret-string 'sk-ant-...' \
     --profile expense-tracker
   ```
   Then restart the ECS service to pick up the new values:
   ```bash
   aws ecs update-service \
     --cluster <EcsClusterName from output> \
     --service <EcsServiceName from output> \
     --force-new-deployment \
     --profile expense-tracker
   ```
   This is a one-time step. Subsequent deploys reuse the same secrets — CDK does not overwrite values that are already set. Both keys are optional — chat models from vendors without a configured key will return a clear error.

### 7. Configure SES for OTP emails (when needed)

Cognito uses its built-in email sender by default, which caps at **~50 emails/day**. This is enough for early use. When you hit the limit, Cognito returns `LimitExceededException` and users cannot log in until the next day.

To remove the limit, switch Cognito to send via Amazon SES:

#### 7a. Verify your domain in SES

```bash
aws sesv2 create-email-identity \
  --email-identity yourdomain.com \
  --profile expense-tracker
```

SES will return DKIM tokens. Add them as CNAME records in Cloudflare:

```bash
# SES prints 3 DKIM tokens — add each as a CNAME in Cloudflare DNS:
# Name: <token>._domainkey.yourdomain.com
# Target: <token>.dkim.amazonses.com
# Proxy status: DNS only (grey cloud)
```

Wait for verification (usually a few minutes):

```bash
aws sesv2 get-email-identity \
  --email-identity yourdomain.com \
  --query 'DkimAttributes.Status' \
  --profile expense-tracker
# Expected: "SUCCESS"
```

#### 7b. Request SES production access

By default SES is in **sandbox mode** (can only send to verified emails). Request production access:

1. Go to **AWS Console → SES → Account dashboard → Request production access**
2. Fill in:
   - **Mail type**: Transactional
   - **Use case**: "One-time login codes (OTP) for a web application. No marketing emails."
   - **Expected volume**: your estimate (e.g. "under 100/day")

Approval is usually within 24 hours.

#### 7c. Update CDK to use SES

Add SES email configuration to the Cognito User Pool in `infra/aws/lib/auth.ts`:

```typescript
email: cognito.UserPoolEmail.withSES({
  fromEmail: "noreply@yourdomain.com",
  fromName: "Expense Tracker",
  sesRegion: "<your-region>",
}),
```

Deploy the change. After this, Cognito sends OTP emails through SES with no daily limit.

## CI/CD (automatic deploys on push)

CDK creates an IAM OIDC role for GitHub Actions. Requires step 5 (first deploy + initial image push) to be completed first — CI/CD reads stack outputs and pushes to existing ECR repos.

After first deploy:
1. Copy `GithubDeployRoleArn` from CDK outputs
2. In GitHub repo settings, add:

   **Secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `AWS_DEPLOY_ROLE_ARN` — the role ARN from step 1
   - `CDK_CERTIFICATE_ARN` — ACM certificate ARN (Cloudflare Origin Cert, from step 3d)
   - `CDK_API_CERTIFICATE_ARN` — ACM certificate ARN (public cert for API domain, from step 3e)

   **Variables** (Settings → Secrets and variables → Actions → Variables):
   - `AWS_REGION` — target region (e.g. `eu-central-1`)
   - `CDK_DOMAIN_NAME` — your domain (e.g. `myfinance.com`)
   - `CDK_ALERT_EMAIL` — email for CloudWatch alarm notifications
   - `CDK_GITHUB_REPO` — GitHub repo (e.g. `user/expense-budget-tracker`)

3. Every push to `main` will automatically:
   - `cdk deploy` — update infrastructure, Lambda, and IAM permissions
   - Build and push Docker images to ECR (tagged with git SHA + `latest`)
   - Run migration ECS task (one-off Fargate task)
   - Restart ECS service (`force-new-deployment` picks up the new `latest` image)

No AWS keys stored in GitHub — uses OIDC federation.

## Domain routing

- `domain.com` → ALB → 302 redirect to `app.domain.com` (no container, just an ALB rule)
- `app.domain.com` → ALB → ECS Fargate web container (port 8080)
To serve your own site on `domain.com`, point its DNS to your site's hosting (Vercel, etc.). The ALB redirect becomes irrelevant since traffic no longer reaches it.

## Auth flow

1. User visits the app → Cloudflare edge → ALB → Next.js proxy
2. Unauthenticated users are redirected to `auth.*` (Email OTP form)
3. User enters email → auth service calls Cognito `InitiateAuth` (EMAIL_OTP) → OTP sent to email
4. User enters 8-digit code → auth service calls Cognito `RespondToAuthChallenge` → receives tokens
5. Auth service sets `session` + `refresh` cookies (Domain=baseDomain), JS redirects to app
6. App verifies IdToken from `session` cookie via `CognitoJwtVerifier` (`AUTH_MODE=cognito`)
7. `/api/health` bypasses auth (for ALB health checks)

## Monitoring

- **Alarms**: ALB 5xx (>5 in 5min), API Gateway 5xx (>5 in 5min), ECS CPU (>80% for 15min), ECS memory (>80% for 15min), ECS scale-out (>1 task), DB connections (>80%), DB storage (<2GB), Lambda errors (FX fetcher, SQL API authorizer, SQL API executor)
- **Access logs**: S3 bucket with all HTTP requests, 90-day retention
- **Container logs**: CloudWatch Logs `/expense-tracker/web` and `/expense-tracker/migrate`, 30-day retention
- **Lambda logs**: CloudWatch Logs (automatic), searchable in console

## Container access

Use ECS Exec to open a shell in the running web container:

```bash
aws ecs execute-command \
  --cluster <EcsClusterName from output> \
  --task <task-id> \
  --container web \
  --interactive \
  --command "/bin/sh" \
  --profile expense-tracker
```

To find the running task ID:

```bash
aws ecs list-tasks --cluster <EcsClusterName> --service-name <EcsServiceName> --profile expense-tracker
```

## Tear down

```bash
npx cdk destroy
```

Note: RDS creates a final snapshot on destroy. Cognito User Pool is retained to prevent user data loss. Cloudflare DNS records and Origin Certificate are not affected by `cdk destroy` — delete them manually in the Cloudflare Dashboard if needed.
