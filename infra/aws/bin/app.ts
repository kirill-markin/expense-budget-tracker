#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import * as fs from "fs";
import * as path from "path";
import { ExpenseBudgetTrackerStack } from "../lib/stack";

const app = new cdk.App();

// Load local context (secrets) from cdk.context.local.json if it exists.
// This file is gitignored and contains account-specific values.
const localContextPath = path.join(__dirname, "..", "cdk.context.local.json");
if (fs.existsSync(localContextPath)) {
  const localContext = JSON.parse(fs.readFileSync(localContextPath, "utf-8"));
  for (const [key, value] of Object.entries(localContext)) {
    if (value) {
      app.node.setContext(key, value);
    }
  }
}

const region = app.node.tryGetContext("region") as string | undefined;
if (!region) {
  throw new Error("Missing required context: 'region'. Set it in cdk.context.local.json or pass via -c region=eu-central-1");
}

const domainName = app.node.tryGetContext("domainName") as string | undefined;
if (!domainName) {
  throw new Error("Missing required context: 'domainName'. Set it in cdk.context.local.json (e.g. \"yourdomain.com\")");
}

const certificateArn = app.node.tryGetContext("certificateArn") as string | undefined;
if (!certificateArn) {
  throw new Error("Missing required context: 'certificateArn'. Set it in cdk.context.local.json (ACM certificate ARN — run scripts/cloudflare/setup-certificate.sh first)");
}

const alertEmail = app.node.tryGetContext("alertEmail") as string | undefined;
if (!alertEmail) {
  throw new Error("Missing required context: 'alertEmail'. Set it in cdk.context.local.json (email for CloudWatch alarm notifications)");
}

const githubRepo = app.node.tryGetContext("githubRepo") as string | undefined;
if (!githubRepo) {
  throw new Error("Missing required context: 'githubRepo'. Set it in cdk.context.local.json (e.g. \"user/expense-budget-tracker\")");
}

const resendApiKeySecretArn = app.node.tryGetContext("resendApiKeySecretArn") as string | undefined;
if (!resendApiKeySecretArn) {
  throw new Error("Missing required context: 'resendApiKeySecretArn'. Set it in cdk.context.local.json after running scripts/resend/create-resend-runtime-key.sh");
}

const resendSenderEmail = app.node.tryGetContext("resendSenderEmail") as string | undefined;
if (!resendSenderEmail) {
  throw new Error("Missing required context: 'resendSenderEmail'. Set it in cdk.context.local.json (e.g. \"no-reply@mail.yourdomain.com\")");
}

new ExpenseBudgetTrackerStack(app, "ExpenseBudgetTracker", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Self-hosted expense & budget tracker: ECS Fargate + RDS + ALB + Cognito + WAF + Lambda",
});
