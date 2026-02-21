# AWS Deployment (CDK)

Deploy expense-budget-tracker to your own AWS account using AWS CDK.

## What gets created

- **VPC** with public and private subnets (2 AZs, 1 NAT gateway)
- **RDS Postgres 16** (t4g.micro) in private subnet, credentials in Secrets Manager
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

## Prerequisites

1. AWS account with CLI configured (`aws configure`)
2. Node.js 20+
3. CDK CLI: `npm install -g aws-cdk`
4. CDK bootstrapped in your account: `cdk bootstrap`
5. ACM certificate ARN for HTTPS (required for Cognito auth)

## Setup

```bash
cd infra/aws
npm install
cp cdk.context.local.example.json cdk.context.local.json
# Edit cdk.context.local.json with your values
```

### Configuration (cdk.context.local.json)

| Parameter | Required | Description |
|---|---|---|
| `domainName` | Yes (for HTTPS) | Your domain, e.g. `money.example.com` |
| `certificateArn` | Yes (for HTTPS) | ACM certificate ARN for your domain |
| `alertEmail` | Recommended | Email for CloudWatch alarm notifications |
| `githubRepo` | Recommended | GitHub repo for CI/CD, e.g. `user/expense-budget-tracker` |
| `hostedZoneId` | Optional | Route 53 hosted zone ID for automatic DNS |
| `keyPairName` | Optional | EC2 key pair name for SSH access |

## Initial deploy

```bash
cdk deploy
```

## CI/CD (automatic deploys on push)

If `githubRepo` is set in config, CDK creates an IAM OIDC role for GitHub Actions.

After first deploy:
1. Copy `GithubDeployRoleArn` from CDK outputs
2. Add it as `AWS_DEPLOY_ROLE_ARN` secret in GitHub repo settings
3. Every push to `main` will automatically:
   - `cdk deploy` — update infrastructure + Lambda
   - SSM command to EC2 — `git pull` + `docker compose build` + migrate + restart

No AWS keys stored in GitHub — uses OIDC federation.

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
