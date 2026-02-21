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
  throw new Error("Missing required context: 'domainName'. Set it in cdk.context.local.json (e.g. \"myfinance.com\")");
}

const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string | undefined;
if (!hostedZoneId) {
  throw new Error("Missing required context: 'hostedZoneId'. Set it in cdk.context.local.json (Route 53 hosted zone ID for your domain)");
}

new ExpenseBudgetTrackerStack(app, "ExpenseBudgetTracker", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Self-hosted expense & budget tracker: EC2 + RDS + ALB + Cognito + WAF + Lambda",
});
