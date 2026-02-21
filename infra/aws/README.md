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

## Prerequisites

1. AWS account with CLI configured (`aws configure`)
2. Node.js 20+
3. CDK CLI: `npm install -g aws-cdk`
4. CDK bootstrapped in your account: `cdk bootstrap`
5. ACM certificate ARN for HTTPS (required for Cognito auth)
6. (Optional) EC2 key pair name for SSH access

## Deploy

```bash
cd infra/aws
npm install

# Full deploy with HTTPS + Cognito auth
cdk deploy \
  --context certificateArn=arn:aws:acm:us-east-1:123456789:certificate/abc-123 \
  --context domainName=money.example.com

# With SSH access
cdk deploy \
  --context certificateArn=arn:aws:acm:us-east-1:123456789:certificate/abc-123 \
  --context domainName=money.example.com \
  --context keyPairName=my-key

# HTTP only (dev/testing, no auth)
cdk deploy
```

## After deploy

1. CDK outputs the ALB DNS name — point your domain's CNAME there
2. Create your first user in Cognito:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId from output> \
     --username you@example.com \
     --temporary-password 'TempPass123!'
   ```
3. DB credentials are in AWS Secrets Manager (`expense-tracker/db-credentials`)
4. Migrations run automatically on first EC2 boot
5. FX rates are fetched daily at 08:00 UTC by Lambda

## Auth flow

1. User visits the app → ALB redirects to Cognito hosted UI
2. User logs in → Cognito issues JWT
3. ALB validates JWT → sets `x-amzn-oidc-data` header
4. App reads the header (`AUTH_MODE=proxy`) → user is authenticated
5. `/api/health` bypasses auth (for ALB health checks)

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

Note: RDS uses SNAPSHOT removal policy — a final snapshot is created on destroy.
Cognito User Pool is RETAINED to prevent accidental user data loss.
