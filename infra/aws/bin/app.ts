#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ExpenseBudgetTrackerStack } from "../lib/stack";

const app = new cdk.App();

new ExpenseBudgetTrackerStack(app, "ExpenseBudgetTracker", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Self-hosted expense & budget tracker: EC2 + RDS + ALB + Lambda FX fetchers",
});
