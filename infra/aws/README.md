# AWS Deployment (CDK)

Deploy expense-budget-tracker to your own AWS account using AWS CDK.

## AWS account isolation

Each deployment should live in its own dedicated AWS account. This is the AWS equivalent of a GCP project — complete isolation of resources, IAM, billing, and service quotas with zero risk of collisions with other workloads.

### Why a separate account

- **Blast radius**: a misconfigured IAM policy or runaway resource cannot affect your other projects.
- **Billing visibility**: costs appear as a separate line item in consolidated billing — no tag-based filtering required.
- **Clean teardown**: `cdk destroy` removes everything; no leftover resources hiding among unrelated stacks.
- **Security boundary**: the stack creates its own VPC, security groups, IAM roles, and Secrets Manager entries. A separate account guarantees no naming or ARN collisions.

### Create a dedicated account (one-time setup)

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

### Configure CLI profile

Add a named profile that assumes the cross-account role created automatically by Organizations:

```ini
# ~/.aws/config
[profile expense-tracker]
role_arn = arn:aws:iam::<NEW_ACCOUNT_ID>:role/OrganizationAccountAccessRole
source_profile = default
region = eu-central-1
```

Then deploy with:

```bash
export AWS_PROFILE=expense-tracker
cdk bootstrap   # first time only
cdk deploy
```

All CDK commands, AWS CLI calls, and GitHub Actions will target this account via the profile or role ARN.

### Alternative: same account

If you prefer not to create a separate account, the stack still works — all resources are namespaced under the CloudFormation stack name `ExpenseBudgetTracker` and use `${ACCOUNT_ID}` suffixes for globally unique names (S3 buckets, Cognito domain). Add a `project=expense-budget-tracker` tag in your cost allocation settings for billing visibility.

## What gets created

- **VPC** with public and private subnets (2 AZs, 1 NAT gateway)
- **RDS Postgres 18** (t4g.micro) in private subnet, credentials in Secrets Manager
- **EC2** (t3.small) running Docker Compose: web app (Next.js)
- **ALB** with HTTPS + Cognito authentication (JWT via ALB auth action)
- **Cognito User Pool** — managed auth with hosted login UI, no auth code in the app
- **AWS WAF** on ALB — rate limiting (1000 req/5min per IP), SQLi/XSS protection, common threat rules
- **Lambda** (Python 3.12) for daily FX rate fetching + EventBridge schedule at 08:00 UTC
- **CloudWatch Alarms + SNS** — alerts on ALB 5xx, EC2 CPU, DB connections, DB storage, Lambda errors
- **S3** — ALB access logs (90-day retention)
- **CloudWatch Logs** — Docker container logs from EC2 (30-day retention), Lambda logs (automatic)
- **Route 53** — DNS A-record pointing to ALB (optional, if hosted zone provided)
- **AWS Backup** — daily backup plan with 35-day retention for RDS
- **GitHub Actions OIDC** — CI/CD role for push-to-deploy (optional, if `githubRepo` provided)

## First-time setup checklist

1. Create a dedicated AWS account (see "AWS account isolation" above):
   ```bash
   aws organizations create-account \
     --email you+expense-tracker@gmail.com \
     --account-name "expense-budget-tracker"
   ```
2. Add a CLI profile in `~/.aws/config`:
   ```ini
   [profile expense-tracker]
   role_arn = arn:aws:iam::<NEW_ACCOUNT_ID>:role/OrganizationAccountAccessRole
   source_profile = default
   region = eu-central-1
   ```
3. Install prerequisites: Node.js 24+, CDK CLI (`npm install -g aws-cdk`), ACM certificate for your domain
4. Bootstrap CDK in the target account:
   ```bash
   AWS_PROFILE=expense-tracker cdk bootstrap
   ```
5. Configure the stack:
   ```bash
   cd infra/aws
   npm install
   cp cdk.context.local.example.json cdk.context.local.json
   # edit cdk.context.local.json with your values
   ```
6. Deploy:
   ```bash
   AWS_PROFILE=expense-tracker cdk deploy
   ```

### Configuration (cdk.context.local.json)

| Parameter | Required | Description |
|---|---|---|
| `region` | Yes | AWS region, e.g. `eu-central-1` |
| `domainName` | Yes (for HTTPS) | Your domain, e.g. `money.example.com` |
| `certificateArn` | Yes (for HTTPS) | ACM certificate ARN for your domain |
| `alertEmail` | Recommended | Email for CloudWatch alarm notifications |
| `githubRepo` | Recommended | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |
| `hostedZoneId` | Optional | Route 53 hosted zone ID for automatic DNS |
| `keyPairName` | Optional | EC2 key pair name for SSH access |

## Initial deploy

```bash
# If using a dedicated account profile:
AWS_PROFILE=expense-tracker cdk deploy

# Or if your default profile already targets the right account:
cdk deploy
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

No AWS keys stored in GitHub — uses OIDC federation. The role ARN encodes the target account ID, so the pipeline always deploys to the correct account.

## After initial deploy

1. Confirm SNS email subscription in your inbox
2. Create your first user in Cognito:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId from output> \
     --username you@example.com \
     --temporary-password 'TempPass123!'
   ```
3. Visit your domain — Cognito login page appears

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
