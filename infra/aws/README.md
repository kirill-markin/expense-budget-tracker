# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK. DNS and domain managed by Cloudflare.

## Estimated cost

| Item | Cost | Why |
|---|---|---|
| Domain (`.com`, Cloudflare) | ~$10/year | Custom domain for the app (`app.yourdomain.com`) |
| ECS Fargate (0.5 vCPU / 1 GB ARM64, 24/7) | ~$13/month | Runs Next.js web app container |
| RDS t4g.micro (24/7) | ~$12/month | Managed Postgres with automated backups, private subnet isolation |
| NAT instance t4g.small | ~$12/month | Outbound internet for ECS (ECR pulls) and Lambda in private subnet |
| ALB | ~$16/month | HTTPS termination with Origin Certificate, health checks |
| S3, CloudWatch, WAF, Lambda | ~$3/month | Access logs, alarms, SQLi/XSS protection, and scheduled FX rates |
| API Gateway + Lambda | ~$0/month | REST API for machine SQL and a separate HTTP API v2 for MCP; negligible at low volume |
| **AWS total** | **~$10/year + ~$50/month** | Uses the Cloudflare Free plan |

Cloudflare Free provides DNS, CDN, DDoS protection, and edge SSL. AWS WAF on the auth ALB owns anonymous OAuth registration throttling, so no paid Cloudflare plan is required. All prices are approximate for `eu-central-1` and may vary.

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

Machine → Cloudflare → API Gateway (REST API) → Lambda Authorizer → Machine API Lambda → RDS
                         │
                         └─ api.* ──────────▶ GET /v1/ + authenticated /v1/* (ApiKey auth)

MCP client → Cloudflare → API Gateway (HTTP API v2) → MCP Lambda → RDS
                          │
                          └─ mcp.* ──────────▶ POST /mcp (OAuth Bearer auth)
```

**Cloudflare** handles domain registration, DNS, CDN caching, DDoS protection, and edge TLS.
**AWS** handles compute, database, auth, monitoring, and application logic.

## What gets created

**On AWS (via CDK):**

- **VPC** with public and private subnets (2 AZs, 1 NAT instance — t4g.small for cost savings)
- **RDS Postgres 18** (t4g.micro) in private subnet, credentials in Secrets Manager
- **Secrets Manager** — DB credentials (auto-generated), app DB password, OpenAI API key, Langfuse public key, Langfuse secret key
- **ECR** — two repositories (`expense-tracker/web`, `expense-tracker/migrate`), images built in CI
- **ECS Fargate** — web service (0.5 vCPU / 1 GB ARM64, 1–3 tasks, CPU-based auto-scaling with alert on scale-out) + one-off migration task definition
- **ALB** with HTTPS (Cloudflare Origin Certificate), forwards traffic to ECS and uses `/api/live` for liveness checks
- **Cognito User Pool** (Essentials tier) — passwordless Email OTP auth with a CustomEmailSender Lambda through Resend, managed by the app directly (no Hosted UI)
- **AWS WAF** on ALB — SQLi/XSS protection, common threat rules, and approximate anonymous `POST auth.*/oauth/register` throttling with a 10-request threshold over AWS's native 60-second evaluation window per real client IP from `CF-Connecting-IP`; malformed values match the block action, while AWS WAF omits missing headers, which is accepted because the ALB only accepts Cloudflare edges that supply the header. Cloudflare edge ingress proves only *some* Cloudflare zone, so the rate limits trust `CF-Connecting-IP` fully only once the optional `x-origin-auth` origin shared secret is configured: it both blocks requests that did not pass through our own zone and confines the rate-limit scope to requests carrying it (see [Origin shared secret](#origin-shared-secret-cloudflare--alb))
- **Lambda** (Node.js 24) for daily FX rate fetching + EventBridge schedule at 08:00 UTC, and Cognito custom email delivery through Resend
- **API Gateway** — one REST API with authorizer + executor Lambdas for ApiKey machine SQL, plus an independent HTTP API v2 and Lambda for stateless Streamable HTTP MCP at `/mcp`; the MCP default `execute-api` endpoint is disabled
- **MCP capacity budget** — the HTTP API accepts a burst of 20 and then 10 requests/second, enough for five concurrent clients to each send the normal four-request `initialize`, `notifications/initialized`, `tools/list`, first `tools/call` sequence without exhausting the stage token bucket. Database safety is enforced independently: five reserved Lambda executions × the explicit 10-connection SQL API pool ceiling reserve at most 50 of the t4g.micro's roughly 85 connections, leaving about 35 for web, auth, worker, and the machine SQL API; excess Lambda load may be throttled without expanding that database budget
- **Machine SQL timeout budget** — one 25-second total deadline for `/sql/query`, `/sql/execute`, and compatibility `/sql`, including transaction commit, with bounded cleanup and response headroom below the Regional REST API's 29-second integration timeout and the Lambda's 35-second timeout
- **MCP timeout budget** — one 20-second total MCP SQL execution deadline across transaction setup and every cursor command, a 29-second HTTP API integration timeout, and a 35-second Lambda timeout
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, API Gateway 5xx, ECS CPU/memory, ECS scale-out, DB connections, DB storage, Lambda errors, and unexpected MCP Lambda throttling outside its five-execution capacity envelope
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — ECS web container logs `/expense-tracker/web` (30-day retention), migration logs `/expense-tracker/migrate`, Lambda logs (automatic)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy (ECR push + ECS deploy)

**On Cloudflare (via scripts):**

- Domain registration
- DNS CNAME `@` root domain (proxied) pointing to ALB — redirects to `app.*`
- DNS CNAME `app.*` (proxied) pointing to ALB — authenticated app
- Origin Certificate for ALB HTTPS (imported into ACM)
- Public ACM certificates for the regional `api.*` and `mcp.*` API Gateway domains
- Proxied DNS CNAMEs for `api.*` and `mcp.*`
- Cache bypass for root, `app.*`, `auth.*`, and `mcp.*`
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

Domain and DNS are managed on the Cloudflare Free plan. Cloudflare provides CDN, DDoS protection, and edge SSL on top of DNS, while AWS WAF handles anonymous-registration throttling at the Cloudflare-only origin. No Cloudflare CLI is needed — only the dashboard (for domain registration) and API calls via `curl` (for everything else).

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
  - **Zone → Cache Rules → Edit** (for disabling edge cache on dynamic hosts)

The token needs all four permissions (DNS + SSL + Zone Settings + Cache Rules). Missing any will cause script failures.

Copy the token and save it in your password manager along with the Zone ID from step 3c.

#### 3c. Verify token and find Zone ID (terminal)

Verify the token and find the zone in one credential-isolated subshell. The production token and the helper's temporary curl config disappear when the block exits:

```bash
(
  set -euo pipefail
  export CLOUDFLARE_API_TOKEN="<paste-your-api-token-here>"
  source scripts/cloudflare/cloudflare-api.sh

  cloudflare_api_request \
    "verify Cloudflare API token" \
    "GET" \
    "/user/tokens/verify" \
    "" | python3 -m json.tool

  cloudflare_api_request \
    "find Cloudflare zone yourdomain.com" \
    "GET" \
    "/zones?name=yourdomain.com" \
    "" | python3 -c '
import sys, json
for z in json.load(sys.stdin)["result"]:
    print("Zone: {}  ID: {}  Status: {}".format(z["name"], z["id"], z["status"]))
'
)
```

Expected: `"status": "active"`. Copy the **Zone ID** from the output for the next step. The helper also removes the token from the subshell's exported environment immediately, keeps it in a permission-restricted temporary curl config, retries bounded failures, and redacts diagnostics.

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

This file is gitignored. Every command below loads it only inside its own explicit subshell. Do not source it in the long-lived parent shell.

#### 3d. Create Origin Certificate and import into ACM (terminal)

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a
  export AWS_PROFILE=expense-tracker

  bash scripts/cloudflare/setup-certificate.sh \
    --domain yourdomain.com \
    --region eu-central-1
)
```

The script creates a Cloudflare Origin Certificate (15-year, wildcard) via the API and imports it into AWS ACM. It prints the **certificate ARN** — you need this for step 5.

If Cloudflare accepts the create request but does not return a conclusive response, the script stops without issuing another certificate and retains a mode-0600 private key and CSR. Follow its printed `--resume-dir` command after propagation; resume performs list-only public-key reconciliation and never sends another create request.

> **Why Origin Certificate?** Cloudflare Origin Certificates are free, long-lived (15 years), and trusted by Cloudflare's edge servers. Since all traffic flows through Cloudflare proxy, browsers see Cloudflare's edge certificate (Universal SSL, free). The Origin Certificate secures the connection between Cloudflare and your ALB.

#### 3e. Create API domain certificate (~5-30 min wait)

The SQL API for machine clients (LLM agents, scripts) uses a custom domain (`api.yourdomain.com`). This requires a public ACM certificate in your deployment region. API Gateway custom domains do not accept Cloudflare Origin Certificates — only publicly trusted certificates.

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a
  export AWS_PROFILE=expense-tracker

  bash scripts/cloudflare/setup-api-domain.sh \
    --domain yourdomain.com \
    --region eu-central-1
)
```

The script requests the certificate, validates it via Cloudflare DNS, and waits for it to be issued. It prints the **API certificate ARN** — you need this for step 5.

> **Note:** The ACM validation CNAME record must stay in Cloudflare permanently — ACM needs it for automatic certificate renewal. Do not delete it.

### 4. Configure Resend for OTP emails

Cognito email OTP delivery uses a `CustomEmailSender` Lambda that sends through Resend from `no-reply@mail.yourdomain.com`. The CDK stack requires the Resend secret ARN and sender email during synth/deploy, so complete this step before creating `cdk.context.local.json`, bootstrapping, or deploying.

1. Add the local-only admin Resend key to your local root `.env`:

```dotenv
RESEND_ADMIN_API_KEY=re_...
```

2. Configure and verify the Resend sending domain:

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a

  bash scripts/resend/setup-resend-domain.sh \
    --domain yourdomain.com \
    --subdomain mail
)
```

The script creates or reuses `mail.yourdomain.com`, writes the required DNS records to Cloudflare, skips the Resend verification call when the domain is already verified, and otherwise requests verification before polling briefly. If DNS is still propagating, it exits non-zero; wait and rerun this step before continuing.

3. Create the domain-scoped send-only runtime API key and store it in AWS Secrets Manager:

```bash
bash scripts/resend/create-resend-runtime-key.sh \
  --domain yourdomain.com \
  --subdomain mail \
  --region eu-central-1 \
  --profile expense-tracker
```

This confirms the AWS caller identity, creates `expense-tracker/resend-api-key`, and prints the ARN for `resendApiKeySecretArn`. To rotate an existing runtime key, rerun the command with `--rotate-secret --previous-api-key-id <resend_key_id>` so the old key can be deleted after AWS Secrets Manager is updated. If you manually create the runtime key instead, export it as `RESEND_API_KEY` and run `bash scripts/resend/setup-resend-secret.sh --domain yourdomain.com --subdomain mail --region eu-central-1 --profile expense-tracker`.

Keep the printed secret ARN and derived sender email for the next step:

```json
{
  "resendApiKeySecretArn": "arn:aws:secretsmanager:eu-central-1:123456789012:secret:expense-tracker/resend-api-key-xxxxxx",
  "resendSenderEmail": "no-reply@mail.yourdomain.com"
}
```

See [`docs/resend-setup.md`](../../docs/resend-setup.md) for the full Resend setup flow.

### 5. Configure local CDK context

```bash
cd infra/aws
npm install
cp cdk.context.local.example.json cdk.context.local.json
```

Edit `cdk.context.local.json` with your values:

| Parameter | Description |
|---|---|
| `region` | AWS region, e.g. `eu-central-1` |
| `domainName` | Your domain, e.g. `yourdomain.com` |
| `certificateArn` | ACM certificate ARN from step 3d (Cloudflare Origin Cert) |
| `apiCertificateArn` | ACM certificate ARN from step 3e (public cert for `api.yourdomain.com`) |
| `mcpCertificateArn` | Leave empty until step 5a, then add the public ACM certificate ARN for `mcp.yourdomain.com` |
| `resendApiKeySecretArn` | Secrets Manager ARN for `expense-tracker/resend-api-key` from step 4 |
| `resendSenderEmail` | Cognito sender address from step 4, e.g. `no-reply@mail.yourdomain.com` |
| `langfuseBaseUrl` | Langfuse base URL, defaults to `https://cloud.langfuse.com` |
| `alertEmail` | Email for CloudWatch alarm notifications |
| `githubRepo` | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |
| `originSharedSecret` | Optional. Cloudflare-to-ALB shared secret — leave empty until the Transform Rule exists (see [Origin shared secret](#origin-shared-secret-cloudflare--alb)) |

#### 5a. Create the MCP domain certificate and complete the context (~5-30 min wait)

The canonical MCP endpoint is `https://mcp.yourdomain.com/mcp`. After every existing context value above is complete, leave only `mcpCertificateArn` empty and run:

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a
  export AWS_PROFILE=expense-tracker
  export AWS_REGION=eu-central-1

  bash scripts/cloudflare/setup-mcp-domain.sh \
    --domain yourdomain.com
)
```

The script requires `infra/aws/cdk.context.local.json`, verifies its account, region, and domain against the explicit AWS profile, caller identity, and Cloudflare zone, then requests or reuses the single suitable exact-name certificate. Add the printed ARN as `mcpCertificateArn` in the local context and store the same value as the GitHub Actions secret `CDK_MCP_CERTIFICATE_ARN` before promotion. Keep its DNS-only validation CNAME for ACM renewal.

Rerunning the script reuses the single exact-domain certificate when it is `ISSUED` or `PENDING_VALIDATION`; it stops before DNS changes if multiple reusable exact-domain certificates make selection ambiguous.

#### Custom public site (optional)

By default, the root domain (`yourdomain.com`) redirects to `app.yourdomain.com` via an ALB rule — no extra container or code needed.

To serve your own site on the root domain, deploy it independently (Vercel, Cloudflare Pages, your own server, etc.) and update the Cloudflare DNS CNAME for `@` (root) to point to your site's hosting instead of the ALB. This repo does not manage the public site — they are fully independent.

### 6. Bootstrap and first deploy

```bash
export AWS_PROFILE=expense-tracker
bash scripts/bootstrap.sh --region eu-central-1  # ~15-20 min
```

The script handles the full first-time deployment:
1. `cdk bootstrap` (one-time CDK setup)
2. `cdk deploy` (creates VPC, RDS, ECR, ECS, ALB, etc.)
3. Builds and pushes Docker images (web + migrate) to ECR
4. Runs the migration ECS task
5. Calls `/api/health` through the ALB DNS name until DB readiness succeeds
6. Seeds exchange rates

After this one-time bootstrap, all subsequent deploys happen automatically via CI/CD on push to `main`.

Infrastructure liveness and database readiness are intentionally separate:

- `GET /api/live` returns 200 without touching Postgres and is used by ECS container health checks and the ALB target group.
- `GET /api/health` runs a DB query and is used only as a post-deploy readiness check.

Because the default pipeline still updates the ECS service before optional migrations run, schema changes must remain backward-compatible for at least one deploy. If a change requires “migrate before new code receives traffic”, use a separate two-phase rollout instead of the default pipeline.

After deploy completes, **create the DNS record** pointing to the ALB and configure SSL:

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a
  export AWS_PROFILE=expense-tracker
  export AWS_REGION=eu-central-1

  bash scripts/cloudflare/setup-dns.sh \
    --stack-name ExpenseBudgetTracker \
    --region eu-central-1
)
```

The script creates proxied CNAMEs for the ALB, `api.*`, and `mcp.*`; sets SSL/TLS to Full (Strict); and bypasses cache for dynamic hosts. The AWS WAF attached to the auth ALB separately rate-limits the exact anonymous `POST auth.*/oauth/register` endpoint by the real client IP supplied in `CF-Connecting-IP`.

Verify Cloudflare resources and their CloudFormation targets after DNS propagation:

```bash
(
  set -euo pipefail
  set -a
  source scripts/cloudflare/.env
  set +a
  export AWS_PROFILE=expense-tracker
  export AWS_REGION=eu-central-1

  bash scripts/cloudflare/verify.sh \
    --stack-name ExpenseBudgetTracker
)
```

The canonical MCP transport is `https://mcp.yourdomain.com/mcp`, and its protected-resource metadata is available only at `https://mcp.yourdomain.com/.well-known/oauth-protected-resource/mcp`. The HTTP API's default `execute-api` endpoint is disabled; clients must use the root-mapped custom domain without a stage prefix.

### 7. Post-deploy

1. **Confirm SNS email** — check the `alertEmail` inbox for a message from "AWS Notifications" with subject "AWS Notification - Subscription Confirmation". Click the "Confirm subscription" link inside. Without this, CloudWatch alarm notifications will not be delivered
2. **Visit your domain** — Email OTP login page appears. Open registration: anyone can sign up with email. Each user gets an isolated workspace via RLS — no shared data between users
3. **Session encryption key** — CDK auto-generates a cryptographically random 32-byte hex key in Secrets Manager (`expense-tracker/session-encryption-key`). It encrypts the OTP session cookie (Cognito session + email + CSRF token) with AES-256-GCM during the login flow. Rotating this key invalidates only in-flight OTP sessions (users mid-login must request a new code). To rotate: `aws secretsmanager put-secret-value --secret-id expense-tracker/session-encryption-key --secret-string "$(openssl rand -hex 32)" --profile expense-tracker`, then restart the auth ECS service
4. **Set AI and telemetry secrets (first deploy only)** — the AI chat feature uses OpenAI GPT-5.4 and exports traces to Langfuse Cloud. CDK creates placeholder secrets in AWS Secrets Manager on the first deploy; replace them with real values once:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id expense-tracker/openai-api-key \
     --secret-string 'sk-...' \
     --profile expense-tracker

   aws secretsmanager put-secret-value \
     --secret-id expense-tracker/langfuse-public-key \
     --secret-string 'pk-lf-...' \
     --profile expense-tracker

   aws secretsmanager put-secret-value \
     --secret-id expense-tracker/langfuse-secret-key \
     --secret-string 'sk-lf-...' \
     --profile expense-tracker
   ```
   `langfuseBaseUrl` is injected as a regular ECS environment variable and defaults to `https://cloud.langfuse.com`. Then restart the ECS service to pick up the new values:
   ```bash
   aws ecs update-service \
     --cluster <EcsClusterName from output> \
     --service <EcsServiceName from output> \
     --force-new-deployment \
     --profile expense-tracker
   ```
   This is a one-time step. Subsequent deploys reuse the same secret — CDK does not overwrite values that are already set.
   If you are upgrading an existing stack to the app-managed chat runtime, make sure the migration ECS task applies `0032_chat_runtime_local_loop.sql`. That migration drops `openai_conversation_id` and `chat_code_interpreter_containers`, and the new runtime does not support OpenAI Conversations or hosted code interpreter containers.

5. **Verify Langfuse traces** — after the ECS restart, send one real chat message in the web UI and confirm that Langfuse shows:
   - trace name `chat_turn`
   - session-scoped grouping by the chat `sessionId`
   - tags `surface:web-chat`, `runtime:local-loop`, and `vendor:openai`
   - metadata with `requestId`, `workspaceId`, `model`, `turnIndex`, and `runState`
   - nested observations for the OpenAI generation and any local `query_database` tool call

   The production runtime is fully app-managed now: transcript state lives in Postgres, the tool loop runs in the web process, and recovery uses `/api/chat` snapshots instead of provider-managed conversation state. For ongoing operations and troubleshooting, use [`docs/langfuse-operations.md`](../../docs/langfuse-operations.md).

## CI/CD (automatic deploys on push)

CDK creates an IAM OIDC role for GitHub Actions. Requires step 6 (first deploy + initial image push) to be completed first — CI/CD reads stack outputs and pushes to existing ECR repos.

After first deploy:
1. Copy `GithubDeployRoleArn` from CDK outputs
2. In GitHub repo settings, add:

   **Secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `AWS_DEPLOY_ROLE_ARN` — the role ARN from step 1
   - `CDK_CERTIFICATE_ARN` — ACM certificate ARN (Cloudflare Origin Cert, from step 3d)
   - `CDK_API_CERTIFICATE_ARN` — ACM certificate ARN (public cert for API domain, from step 3e)
   - `CDK_MCP_CERTIFICATE_ARN` — ACM certificate ARN (public cert for MCP domain, from step 5a)
   - `CDK_ORIGIN_SHARED_SECRET` — optional Cloudflare-to-ALB shared secret; see [Origin shared secret](#origin-shared-secret-cloudflare--alb) before setting it

   **Variables** (Settings → Secrets and variables → Actions → Variables):
   - `AWS_REGION` — target region (e.g. `eu-central-1`)
   - `CDK_DOMAIN_NAME` — your domain (e.g. `yourdomain.com`)
   - `CDK_ALERT_EMAIL` — email for CloudWatch alarm notifications
   - `CDK_GITHUB_REPO` — GitHub repo (e.g. `user/expense-budget-tracker`)
   - `CDK_RESEND_API_KEY_SECRET_ARN` — Secrets Manager ARN for `expense-tracker/resend-api-key`
   - `CDK_RESEND_SENDER_EMAIL` — `no-reply@mail.yourdomain.com`
   - `CDK_LANGFUSE_BASE_URL` — optional custom Langfuse base URL; omit it to use `https://cloud.langfuse.com`

3. Every push to `main` will automatically:
   - `cdk deploy` — update infrastructure, Lambda, and IAM permissions
   - Build and push Docker images to ECR (tagged with git SHA + `latest`)
   - Run migration ECS task (one-off Fargate task)
   - Restart ECS service (`force-new-deployment` picks up the new `latest` image)

No AWS keys stored in GitHub — uses OIDC federation.

## Origin shared secret (Cloudflare → ALB)

The ALB security group only accepts Cloudflare edge ranges, which proves a request came from *some* Cloudflare zone. An attacker can point their own Cloudflare zone at the ALB, bypass this zone's rules, and send an arbitrary `CF-Connecting-IP`, which defeats the WAF rate limits keyed on that header. A shared secret injected by a Transform Rule proves the request came from *our* zone, because Transform Rules are per-zone.

- Header: `x-origin-auth` (lowercase — AWS WAF `singleHeader` names must be lowercase)
- CDK context key: `originSharedSecret`; GitHub Actions secret: `CDK_ORIGIN_SHARED_SECRET`
- While the value is empty, absent, or whitespace-only, the web ACL is byte-for-byte unchanged and no request is blocked
- Once the value is set (surrounding whitespace is stripped), the WAF rule `BlockRequestsWithoutOriginSharedSecret` (priority 9, metric `expense-tracker-origin-secret-block`) blocks every request whose `x-origin-auth` header is missing or not exactly equal to the secret
- The same value is also required inside the scope-down of both `CF-Connecting-IP` rate-limit rules. A rate-based rule aggregates every request it evaluates and a later block does not un-count it, so without this a forged `CF-Connecting-IP` from a foreign zone could still exhaust a victim IP's registration or token budget before being blocked. Existing rule priorities are unchanged
- ALB target health checks reach the targets directly without traversing the web ACL, so they are unaffected
- The `WafOriginSecretBlockedAlarm` CloudWatch alarm notifies the alert topic when this rule blocks more than 50 requests in 5 minutes — target health checks stay green during a secret mismatch, so this alarm is the signal that the zone and the ACL diverged

Generate the value with a shell-safe generator, for example `openssl rand -hex 32`.

> **Warning:** activate in this order. Setting the secret before the Cloudflare Transform Rule exists blocks all public traffic to `app.*` and `auth.*` and takes the whole site down.

1. **First**, create a Transform Rule (Rules → Transform Rules → Modify Request Header) in the Cloudflare zone that sets `x-origin-auth` to the secret on every request to the proxied hostnames, and confirm it is live.
2. **Second**, store the same value as the `CDK_ORIGIN_SHARED_SECRET` GitHub Actions secret (and in `cdk.context.local.json` for local deploys) and deploy.

To roll back, clear the GitHub Actions secret and deploy: the rule disappears from the web ACL. The secret is part of the synthesized CloudFormation template — that is accepted, because it only authenticates the Cloudflare-to-ALB hop and grants no access to user data.

The rule accepts exactly one value, so rotation needs the same two-phase discipline as activation, in reverse: change the Cloudflare Transform Rule to the new value first, then update `CDK_ORIGIN_SHARED_SECRET` and deploy. Traffic is blocked for the window between the two steps, so rotate during a maintenance window, or turn the secret off, rotate, and turn it back on.

## Domain routing

- `domain.com` → ALB → 302 redirect to `app.domain.com` (no container, just an ALB rule)
- `app.domain.com` → ALB → ECS Fargate web container (port 8080)
- `auth.domain.com` → ALB → ECS Fargate auth container (port 8081)
- `api.domain.com/v1/*` → SQL REST API → Lambda authorizer + machine API Lambda
- `mcp.domain.com/mcp` → dedicated MCP HTTP API v2 → MCP Lambda
To serve your own site on `domain.com`, point its DNS to your site's hosting (Vercel, etc.). The ALB redirect becomes irrelevant since traffic no longer reaches it.

## Auth flow

1. User visits the app → Cloudflare edge → ALB → Next.js proxy
2. Unauthenticated users are redirected to `auth.*` (Email OTP form)
3. User enters email → auth service calls Cognito `InitiateAuth` (EMAIL_OTP) → OTP sent to email
4. User enters 8-digit code → auth service calls Cognito `RespondToAuthChallenge` → receives tokens
5. Auth service sets `session` + `refresh` cookies (Domain=baseDomain), JS redirects to app
6. App verifies IdToken from `session` cookie via `CognitoJwtVerifier` (`AUTH_MODE=cognito`)
7. `/api/live` and `/api/health` bypass auth; `/api/live` is for ALB/ECS liveness and `/api/health` is for post-deploy DB readiness

## Monitoring

- **Alarms**: ALB 5xx, SQL and MCP API Gateway 5xx, WAF body/query re-blocks, ECS CPU/memory and scale-out, DB connections/storage, Lambda errors, and unexpected MCP Lambda throttling outside its five-execution capacity envelope
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
