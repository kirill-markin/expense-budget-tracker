# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK.

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

## What gets created

- **VPC** with public and private subnets (2 AZs, 1 NAT instance — t4g.nano for cost savings)
- **RDS Postgres 18** (t4g.micro) in private subnet, credentials in Secrets Manager
- **EC2** (t3.small) running Docker Compose: web app (Next.js)
- **ALB** with HTTPS + Cognito authentication (JWT via ALB auth action)
- **ACM Certificate** — auto-created, DNS validation via Route 53
- **Route 53** — DNS A-record pointing to ALB
- **Cognito User Pool** — managed auth with hosted login UI, no auth code in the app
- **AWS WAF** on ALB — rate limiting (1000 req/5min per IP), SQLi/XSS protection, common threat rules
- **Lambda** (Node.js 24) for daily FX rate fetching + EventBridge schedule at 08:00 UTC
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, EC2 CPU, DB connections, DB storage, Lambda errors
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — Docker container logs from EC2 (30-day retention), Lambda logs (automatic)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy (if `githubRepo` provided)

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

### 3. Register a domain in Route 53

Register a domain via the **AWS Console** or **CLI**. Pricing depends on TLD — `.com` domains cost ~$14/year, paid upfront for 1 year (minimum).

> **Note:** Route 53 Domains API is only available in `us-east-1`, regardless of your deployment region. This is an AWS limitation — it only affects domain registration, not DNS or infrastructure.

**Option A — CLI:**

```bash
# Check availability
aws route53domains check-domain-availability \
  --region us-east-1 \
  --domain-name myfinance.com \
  --profile expense-tracker

# Register (replace contact details with your own)
aws route53domains register-domain \
  --region us-east-1 \
  --profile expense-tracker \
  --domain-name myfinance.com \
  --duration-in-years 1 \
  --auto-renew \
  --privacy-protect-admin-contact \
  --privacy-protect-registrant-contact \
  --privacy-protect-tech-contact \
  --admin-contact '{"FirstName":"…","LastName":"…","ContactType":"PERSON","Email":"…","PhoneNumber":"+1.5551234567","AddressLine1":"…","City":"…","CountryCode":"US","ZipCode":"…"}' \
  --registrant-contact '<same as admin>' \
  --tech-contact '<same as admin>'

# Check registration status
aws route53domains get-operation-detail \
  --region us-east-1 \
  --profile expense-tracker \
  --operation-id <operation-id-from-register-output>
```

> **New accounts:** domain registration may fail until account verification (billing) is complete. If it fails, check Billing console or contact AWS Support.

**Option B — Console:**

1. Open the Route 53 domain registration page:
   `https://console.aws.amazon.com/route53/domains/home#/DomainRegistration`
   Make sure you are in the correct AWS account (the one from step 1).
2. Click **Register domains**.
3. Search for the domain, fill in contact information, and complete the purchase.
4. Wait for registration to complete (usually 5–15 minutes, up to 48 hours for some TLDs).

**To transfer an existing domain from another registrar:**

1. Open: `https://console.aws.amazon.com/route53/domains/home#/DomainTransfer`
2. Click **Transfer domain** and follow the instructions (unlock the domain at your current registrar, get the auth code, etc.).

**After registration or transfer**, Route 53 automatically creates a **Hosted Zone** for your domain. Get its ID:

```bash
aws route53 list-hosted-zones-by-name \
  --dns-name myfinance.com \
  --query "HostedZones[0].Id" --output text \
  --profile expense-tracker
```

This returns something like `/hostedzone/Z0123456789ABCDEFGHIJ` — the part after `/hostedzone/` is your **hostedZoneId**.

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
| `domainName` | **Yes** | Domain registered in Route 53, e.g. `myfinance.com` |
| `hostedZoneId` | **Yes** | Route 53 hosted zone ID from step 3 |
| `subdomain` | Optional | Subdomain prefix (default: `app` → `app.myfinance.com`). Set to `""` for root domain |
| `alertEmail` | Recommended | Email for CloudWatch alarm notifications |
| `githubRepo` | Recommended | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |
| `keyPairName` | Optional | EC2 key pair name for SSH access |

### 5. Bootstrap and deploy

```bash
export AWS_PROFILE=expense-tracker
npx cdk bootstrap   # first time only
npx cdk deploy
```

CDK auto-creates the SSL certificate (DNS validation via Route 53) and the DNS A-record. After deploy completes, the app is live at `https://app.myfinance.com` (or your configured domain).

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

1. User visits the app → ALB redirects to Cognito hosted UI
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

Note: RDS creates a final snapshot on destroy. Cognito User Pool is retained to prevent user data loss.
