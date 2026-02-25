import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface CiCdProps {
  stackId: string;
  webService: ecs.FargateService;
  migrateTaskDef: ecs.FargateTaskDefinition;
  migrateLogGroup: logs.LogGroup;
  cluster: ecs.Cluster;
  fxFetcher: lambda.IFunction;
  githubRepo: string;
}

export function ciCd(scope: Construct, props: CiCdProps): void {
  // --- GitHub Actions OIDC (CI/CD) ---
  const oidcProvider = new iam.OpenIdConnectProvider(scope, "GithubOidc", {
    url: "https://token.actions.githubusercontent.com",
    clientIds: ["sts.amazonaws.com"],
  });

  const deployRole = new iam.Role(scope, "GithubActionsRole", {
    roleName: "expense-tracker-github-deploy",
    assumedBy: new iam.WebIdentityPrincipal(
      oidcProvider.openIdConnectProviderArn,
      {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": `repo:${props.githubRepo}:ref:refs/heads/main`,
        },
      },
    ),
    inlinePolicies: {
      CdkDeploy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "AssumeCdkRoles",
            actions: ["sts:AssumeRole"],
            resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
          }),
          new iam.PolicyStatement({
            sid: "ReadStackOutputs",
            actions: ["cloudformation:DescribeStacks"],
            resources: [props.stackId],
          }),
          new iam.PolicyStatement({
            sid: "EcsDescribeServices",
            actions: ["ecs:DescribeServices"],
            resources: [props.webService.serviceArn],
          }),
          new iam.PolicyStatement({
            sid: "EcsRunMigration",
            actions: ["ecs:RunTask"],
            resources: [
              `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/${props.migrateTaskDef.family}:*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: "EcsDescribeTasks",
            actions: ["ecs:DescribeTasks"],
            resources: [
              `arn:aws:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task/${props.cluster.clusterName}/*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: "PassEcsRoles",
            actions: ["iam:PassRole"],
            resources: [
              props.migrateTaskDef.taskRole.roleArn,
              props.migrateTaskDef.executionRole!.roleArn,
            ],
          }),
          new iam.PolicyStatement({
            sid: "EcsWaitLogs",
            actions: [
              "logs:GetLogEvents",
              "logs:FilterLogEvents",
            ],
            resources: [
              props.migrateLogGroup.logGroupArn,
              `${props.migrateLogGroup.logGroupArn}:*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: "InvokeFxFetcher",
            actions: ["lambda:InvokeFunction"],
            resources: [props.fxFetcher.functionArn],
          }),
        ],
      }),
    },
  });

  new cdk.CfnOutput(scope, "GithubDeployRoleArn", {
    value: deployRole.roleArn,
    description: "IAM role ARN for GitHub Actions deployment",
  });
}
