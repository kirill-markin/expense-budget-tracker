# AWS Deployment (CDK)

Deploy expense-budget-tracker to a dedicated AWS account using AWS CDK.

## Prerequisites

- AWS CLI v2
- Node.js 24+
- CDK CLI: `npm install -g aws-cdk`
- A domain registered in Route 53 (or transferred to Route 53)

## What gets created

- **VPC** with public and private subnets (2 AZs, 1 NAT gateway)
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

Each deployment should live in its own dedicated AWS account — complete isolation of resources, billing, and IAM.

```bash
# Enable Organizations in your main (payer) account (once)
aws organizations create-organization

# Create a member account for the tracker
# Use a unique email — Gmail/Workspace "+" aliases work: you+expense@gmail.com
aws organizations create-account \
  --email you+expense-tracker@gmail.com \
  --account-name "expense-budget-tracker"

# Check creation status
aws organizations list-accounts \
  --query "Accounts[?Name=='expense-budget-tracker']"
```

### 2. Configure CLI profile

Add a named profile that assumes the cross-account role created automatically by Organizations:

```ini
# ~/.aws/config
[profile expense-tracker]
role_arn = arn:aws:iam::<NEW_ACCOUNT_ID>:role/OrganizationAccountAccessRole
source_profile = default
region = eu-central-1
```

### 3. Register a domain in Route 53

Register a new domain or transfer an existing one to Route 53 (console → Route 53 → Registered domains).

After registration, Route 53 automatically creates a **Hosted Zone**. Get its ID:

```bash
aws route53 list-hosted-zones-by-name \
  --dns-name myfinance.com \
  --query "HostedZones[0].Id" --output text
```

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
cdk bootstrap   # first time only
cdk deploy
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

## SSH into EC2

```bash
# Via SSM (no key pair needed)
aws ssm start-session --target <instance-id>

# Via SSH (if key pair provided)
ssh -i my-key.pem ec2-user@<public-ip>
```

## Tear down

```bash
cdk destroy
```

Note: RDS creates a final snapshot on destroy. Cognito User Pool is retained to prevent user data loss.
