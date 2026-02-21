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

new ExpenseBudgetTrackerStack(app, "ExpenseBudgetTracker", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Self-hosted expense & budget tracker: EC2 + RDS + ALB + Cognito + WAF + Lambda",
});
