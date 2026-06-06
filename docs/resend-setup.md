# Resend Setup For Cognito OTP

One-time setup for sending Cognito `EMAIL_OTP` emails through Resend with a Cognito `CustomEmailSender` Lambda.

This repository uses Resend for transactional auth email delivery. The deployed Lambda reads its runtime send-only key from AWS Secrets Manager and sends from a verified domain you control. The examples below use `yourdomain.com`; the project maintainer's production deployment uses `expense-budget-tracker.com`.

## Example naming

- Transactional email subdomain: `mail.yourdomain.com`
- Transactional sender: `no-reply@mail.yourdomain.com`
- AWS Secrets Manager secret: `expense-tracker/resend-api-key`

Use a dedicated `mail` subdomain for transactional auth traffic.

## Prerequisites

Keep these values in root `.env` or export them in the current shell:

- `AWS_REGION`
- `AWS_PROFILE`
- `RESEND_ADMIN_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`

`RESEND_ADMIN_API_KEY` is local-only. It creates the Resend domain and the separate domain-scoped send-only runtime key. The runtime key is written directly to AWS Secrets Manager and is not printed.

`CLOUDFLARE_ZONE_ID` must belong to the exact domain passed through `--domain` or `DOMAIN_NAME`. The setup script verifies the zone before creating the Resend domain or writing DNS records.

## One-time setup

1. Create or reuse the Resend transactional domain, write its DNS records to Cloudflare, and verify it when needed:

```bash
bash scripts/resend/setup-resend-domain.sh --domain yourdomain.com --subdomain mail
```

This script:

- creates or reuses `mail.yourdomain.com` in Resend
- fetches the required DNS records from Resend
- upserts them in Cloudflare as DNS-only records
- skips the Resend verification call when the domain is already `verified`
- triggers Resend domain verification only when the current status is not `verified`
- exits successfully only when Resend reports the domain as `verified`

If DNS is still propagating, the script exits non-zero with the current Resend status. Wait and rerun this step before creating the runtime key.

2. Create a separate domain-scoped send-only API key and store it in AWS Secrets Manager:

```bash
bash scripts/resend/create-resend-runtime-key.sh --domain yourdomain.com --subdomain mail --region eu-central-1 --profile expense-tracker
```

This confirms the AWS caller identity, creates AWS secret `expense-tracker/resend-api-key`, and prints its ARN. Use that ARN as CDK context `resendApiKeySecretArn`.

To rotate an existing runtime key, pass the non-secret id of the previous Resend key so the script can delete it after AWS Secrets Manager is updated:

```bash
bash scripts/resend/create-resend-runtime-key.sh --domain yourdomain.com --subdomain mail --region eu-central-1 --profile expense-tracker --rotate-secret --previous-api-key-id <previous_resend_api_key_id>
```

If the AWS secret already exists and `--previous-api-key-id` is missing, the script fails before creating a new key. The AWS secret stores only the raw runtime token, so the previous key id must come from the Resend dashboard or API.

If you already created a send-only runtime key manually, export it as `RESEND_API_KEY` and run:

```bash
bash scripts/resend/setup-resend-secret.sh --domain yourdomain.com --subdomain mail --region eu-central-1 --profile expense-tracker
```

3. Populate deploy-time config:

- CDK context `resendApiKeySecretArn`: ARN from step 2
- CDK context `resendSenderEmail`: `no-reply@mail.yourdomain.com`
- GitHub Actions variable `CDK_RESEND_API_KEY_SECRET_ARN`: ARN from step 2
- GitHub Actions variable `CDK_RESEND_SENDER_EMAIL`: `no-reply@mail.yourdomain.com`

4. Push the infrastructure change to `main` so CI/CD deploys the updated Cognito custom sender flow.

## Safe validation

Preview DNS changes without mutating Resend or Cloudflare:

```bash
bash scripts/resend/setup-resend-domain.sh --domain yourdomain.com --subdomain mail --dry-run
```

## Notes

- The raw `RESEND_API_KEY` and `RESEND_ADMIN_API_KEY` must never be committed to git, written to deploy config files, or stored in GitHub variables.
- Only the generated send-only runtime key belongs in AWS Secrets Manager because it is the deployed runtime credential. `RESEND_ADMIN_API_KEY` stays local-only.
- CI/CD stores only the AWS Secrets Manager ARN and sender email.
- The deployed auth flow still uses Cognito `EMAIL_OTP`; only the delivery path changes from AWS-managed email to Resend through the Cognito trigger Lambda.
