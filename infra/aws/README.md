# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK. DNS and domain managed by Cloudflare.

## Estimated cost

| Item | Cost | Why |
|---|---|---|
| Domain (`.com`, Cloudflare) | ~$10/year | Custom domain for the app (`app.yourdomain.com`) |
| EC2 t3.small (24/7) | ~$15/month | Runs Next.js web app in Docker |
| RDS t4g.micro (24/7) | ~$12/month | Managed Postgres with automated backups, private subnet isolation |
| NAT instance t4g.nano | ~$3/month | Outbound internet for Lambda in private subnet (FX rate fetching) |
| ALB | ~$16/month | HTTPS termination with Origin Certificate, Cognito auth integration, health checks |
| S3, CloudWatch, WAF, Lambda | ~$3/month | Access logs (S3), container and alarm monitoring (CloudWatch), rate limiting and SQLi/XSS protection (WAF), daily FX rate fetching (Lambda) |
| **Total** | **~$10/year + ~$49/month** | |

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
Browser → Cloudflare (CDN + DDoS + edge SSL) → ALB (Origin Cert) → EC2 (Docker) → RDS
                                                                       ↓
                                                                 Lambda (FX rates)
```

**Cloudflare** handles domain registration, DNS, CDN caching, DDoS protection, and edge TLS.
**AWS** handles compute, database, auth, monitoring, and application logic.

## What gets created

**On AWS (via CDK):**

- **VPC** with public and private subnets (2 AZs, 1 NAT instance — t4g.nano for cost savings)
- **RDS Postgres 18** (t4g.micro) in private subnet, credentials in Secrets Manager
- **EC2** (t3.small) running Docker Compose: web app (Next.js)
- **ALB** with HTTPS (Cloudflare Origin Certificate) + Cognito authentication (JWT via ALB auth action)
- **Cognito User Pool** — managed auth with custom login domain (`auth.yourdomain.com`), no auth code in the app
- **AWS WAF** on ALB — rate limiting (1000 req/5min per IP), SQLi/XSS protection, common threat rules
- **Lambda** (Node.js 24) for daily FX rate fetching + EventBridge schedule at 08:00 UTC
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, EC2 CPU, DB connections, DB storage, Lambda errors
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — Docker container logs from EC2 (30-day retention), Lambda logs (automatic)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy

**On Cloudflare (via scripts):**

- Domain registration
- DNS CNAME `app.*` (proxied) pointing to ALB
- DNS CNAME `auth.*` (DNS-only) pointing to Cognito CloudFront
- Origin Certificate for ALB HTTPS (imported into ACM)
- ACM validation CNAME for auth domain certificate
- Edge SSL, CDN, DDoS protection (automatic with proxied DNS)

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
- **Important:** click "+ Add more" and add two more permissions:
  - **Zone → SSL and Certificates → Edit** (for Origin Certificate creation)
  - **Zone → Zone Settings → Edit** (for setting SSL mode to Full Strict)

The token needs all three permissions (DNS + SSL + Zone Settings). Missing any will cause script failures.

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

#### 3e. Create auth domain certificate (~5-30 min wait)

The login page uses a custom domain (`auth.yourdomain.com`). This requires a public ACM certificate in `us-east-1` (Cognito uses CloudFront under the hood).

```bash
set -a; source scripts/cloudflare/.env; set +a
export AWS_PROFILE=expense-tracker

bash scripts/cloudflare/setup-auth-domain.sh \
  --domain yourdomain.com
```

The script requests the certificate, validates it via Cloudflare DNS, and waits for it to be issued. It prints the **auth certificate ARN** — you need this for step 4.

If your root domain (`yourdomain.com`) does not have an A record yet, the script automatically creates a Cloudflare-proxied placeholder (`192.0.2.1`). This is required because Cognito validates that the parent domain resolves before allowing a custom subdomain. Replace the placeholder with a real server IP when you deploy a landing page on the root domain.

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
| `subdomain` | Subdomain prefix for the app, e.g. `app` → `app.myfinance.com` |
| `certificateArn` | ACM certificate ARN from step 3d (Cloudflare Origin Cert) |
| `authCertificateArn` | ACM certificate ARN from step 3e (public cert in `us-east-1` for `auth.myfinance.com`) |
| `alertEmail` | Email for CloudWatch alarm notifications |
| `githubRepo` | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |

### 5. Bootstrap and deploy

```bash
export AWS_PROFILE=expense-tracker
npx cdk bootstrap                       # first time only
npx cdk deploy --require-approval never  # ~10-15 min
```

After deploy completes, **create the DNS record** pointing to the ALB and configure SSL:

```bash
set -a; source scripts/cloudflare/.env; set +a

bash scripts/cloudflare/setup-dns.sh \
  --subdomain app \
  --stack-name ExpenseBudgetTracker \
  --auth-domain auth.yourdomain.com
```

The script creates the app DNS CNAME (proxied via Cloudflare), sets SSL/TLS to Full (Strict), and creates the auth CNAME (DNS-only, pointing to Cognito's CloudFront distribution).

### 6. Post-deploy

1. **Confirm SNS email** — check the `alertEmail` inbox for a message from "AWS Notifications" with subject "AWS Notification - Subscription Confirmation". Click the "Confirm subscription" link inside. Without this, CloudWatch alarm notifications will not be delivered
2. **Visit your domain** — Cognito sign-up/login page appears. Self-registration is enabled
3. To create users via CLI instead:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <CognitoUserPoolId from output> \
     --username you@example.com \
     --temporary-password 'TempPass123!'
   ```

## CI/CD (automatic deploys on push)

CDK creates an IAM OIDC role for GitHub Actions.

After first deploy:
1. Copy `GithubDeployRoleArn` from CDK outputs
2. In GitHub repo settings, add:
   - **Secret** `AWS_DEPLOY_ROLE_ARN` — the role ARN from step 1
   - **Variable** `AWS_REGION` — target region (e.g. `eu-central-1`)
3. Every push to `main` will automatically:
   - `cdk deploy` — update infrastructure + Lambda
   - SSM command to EC2 — `git pull` + `docker compose build` + migrate + restart

No AWS keys stored in GitHub — uses OIDC federation.

## Auth flow

1. User visits the app → Cloudflare edge → ALB redirects to Cognito hosted UI
2. User logs in → Cognito issues JWT
3. ALB validates JWT → sets `x-amzn-oidc-data` header
4. App reads the header (`AUTH_MODE=proxy`) → user is authenticated
5. `/api/health` bypasses auth (for ALB health checks)

## Monitoring

- **Alarms**: ALB 5xx (>5 in 5min), EC2 CPU (>80% for 15min), DB connections (>80%), DB storage (<2GB), Lambda errors
- **Access logs**: S3 bucket with all HTTP requests, 90-day retention
- **Container logs**: CloudWatch Logs `/expense-tracker/ec2`, 30-day retention
- **Lambda logs**: CloudWatch Logs (automatic), searchable in console

## Shell access to EC2

SSM Session Manager — no key pair needed, no open ports, audit log included:

```bash
aws ssm start-session --target <instance-id> --profile expense-tracker
```

## Tear down

```bash
npx cdk destroy
```

Note: RDS creates a final snapshot on destroy. Cognito User Pool is retained to prevent user data loss. Cloudflare DNS records and Origin Certificate are not affected by `cdk destroy` — delete them manually in the Cloudflare Dashboard if needed.
