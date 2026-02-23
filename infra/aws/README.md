# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK. DNS and domain managed by Cloudflare.

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
- **Cognito User Pool** — managed auth with hosted login UI, no auth code in the app
- **AWS WAF** on ALB — rate limiting (1000 req/5min per IP), SQLi/XSS protection, common threat rules
- **Lambda** (Node.js 24) for daily FX rate fetching + EventBridge schedule at 08:00 UTC
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, EC2 CPU, DB connections, DB storage, Lambda errors
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — Docker container logs from EC2 (30-day retention), Lambda logs (automatic)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy (if `githubRepo` provided)

**On Cloudflare (via scripts):**

- Domain registration
- DNS CNAME record (proxied) pointing to ALB
- Origin Certificate for ALB HTTPS (imported into ACM)
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
- **Important:** click "+ Add more" and add a second permission: **Zone → SSL and Certificates → Edit**

The token needs **both** permissions (DNS + SSL). Without SSL permission, the certificate step will fail.

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

#### 3d. Create Origin Certificate and import into ACM (terminal)

```bash
export AWS_PROFILE=expense-tracker

bash scripts/cloudflare/setup-certificate.sh \
  --domain yourdomain.com \
  --region eu-central-1
```

The script creates a Cloudflare Origin Certificate (15-year, wildcard) via the API and imports it into AWS ACM. It prints the **certificate ARN** — you need this for step 4.

> **Why Origin Certificate?** Cloudflare Origin Certificates are free, long-lived (15 years), and trusted by Cloudflare's edge servers. Since all traffic flows through Cloudflare proxy, browsers see Cloudflare's edge certificate (Universal SSL, free). The Origin Certificate secures the connection between Cloudflare and your ALB.

### 4. Configure the stack

```bash
cd infra/aws
npm install
cp cdk.context.local.example.json cdk.context.local.json
```

Edit `cdk.context.local.json` with your values:

| Parameter | Required | Description |
|---|---|---|
| `region` | **Yes** | AWS region, e.g. `eu-central-1` |
| `domainName` | **Yes** | Your domain, e.g. `myfinance.com` |
| `certificateArn` | **Yes** | ACM certificate ARN from step 3 |
| `subdomain` | Optional | Subdomain prefix (default: `app` → `app.myfinance.com`). Set to `""` for root domain |
| `alertEmail` | Recommended | Email for CloudWatch alarm notifications |
| `githubRepo` | Recommended | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |
| `keyPairName` | Optional | EC2 key pair name for SSH access (not recommended — use SSM instead) |

### 5. Bootstrap and deploy

```bash
export AWS_PROFILE=expense-tracker
npx cdk bootstrap                       # first time only
npx cdk deploy --require-approval never  # ~10-15 min
```

After deploy completes, **create the DNS record** pointing to the ALB:

```bash
export CLOUDFLARE_API_TOKEN="<paste-your-api-token-here>"
export CLOUDFLARE_ZONE_ID="<paste-your-zone-id-here>"

bash scripts/cloudflare/setup-dns.sh \
  --subdomain app \
  --stack-name ExpenseBudgetTracker
```

Then set **SSL/TLS mode to Full (Strict)** via the API:

```bash
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"value":"strict"}' | python3 -m json.tool
```

Or manually: Cloudflare Dashboard → SSL/TLS → Overview → **Full (Strict)**.

### 6. Post-deploy

1. **Confirm SNS email** — check your inbox for the alarm subscription confirmation
2. **Visit your domain** — Cognito sign-up/login page appears. Self-registration is enabled
3. To create users via CLI instead:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <CognitoUserPoolId from output> \
     --username you@example.com \
     --temporary-password 'TempPass123!'
   ```

## CI/CD (automatic deploys on push)

If `githubRepo` is set in config, CDK creates an IAM OIDC role for GitHub Actions.

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

**SSM Session Manager (recommended)** — no key pair needed, no open ports, audit log included:

```bash
aws ssm start-session --target <instance-id> --profile expense-tracker
```

**SSH (optional)** — only if `keyPairName` is set in CDK config:

```bash
ssh -i my-key.pem ec2-user@<public-ip>
```

## Tear down

```bash
npx cdk destroy
```

Note: RDS creates a final snapshot on destroy. Cognito User Pool is retained to prevent user data loss. Cloudflare DNS records and Origin Certificate are not affected by `cdk destroy` — delete them manually in the Cloudflare Dashboard if needed.
