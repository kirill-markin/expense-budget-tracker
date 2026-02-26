import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface OutputsProps {
  appDomain: string;
  alb: elbv2.ApplicationLoadBalancer;
  nlb: elbv2.NetworkLoadBalancer;
  dbDomain: string;
  db: rds.DatabaseInstance;
  appDbSecret: cdk.aws_secretsmanager.Secret;
  userPool: cognito.UserPool;
  userPoolDomain: cognito.UserPoolDomain;
  alertTopic: sns.Topic;
  accessLogsBucket: s3.Bucket;
  cluster: ecs.Cluster;
  webService: ecs.FargateService;
  migrateTaskDef: ecs.FargateTaskDefinition;
  migrateSg: ec2.SecurityGroup;
  fxFetcher: lambda.IFunction;
}

export function outputs(scope: Construct, props: OutputsProps): void {
  // --- Outputs ---
  new cdk.CfnOutput(scope, "AppUrl", {
    value: `https://${props.appDomain}`,
    description: "Application URL (base domain redirects here)",
  });
  new cdk.CfnOutput(scope, "AlbDns", {
    value: props.alb.loadBalancerDnsName,
    description: "ALB DNS name",
  });
  new cdk.CfnOutput(scope, "DbEndpoint", {
    value: props.db.dbInstanceEndpointAddress,
    description: "RDS endpoint (private)",
  });
  new cdk.CfnOutput(scope, "DbSecretArn", {
    value: props.db.secret?.secretArn ?? "N/A",
    description: "Secrets Manager ARN for DB owner credentials",
  });
  new cdk.CfnOutput(scope, "AppDbSecretArn", {
    value: props.appDbSecret.secretArn,
    description: "Secrets Manager ARN for app role credentials",
  });
  new cdk.CfnOutput(scope, "CognitoUserPoolId", {
    value: props.userPool.userPoolId,
    description: "Cognito User Pool ID — create users here",
  });
  new cdk.CfnOutput(scope, "CognitoDomain", {
    value: props.userPoolDomain.domainName,
    description: "Cognito hosted UI domain prefix",
  });
  new cdk.CfnOutput(scope, "AlertTopicArn", {
    value: props.alertTopic.topicArn,
    description: "SNS topic for alerts",
  });
  new cdk.CfnOutput(scope, "AccessLogsBucket", {
    value: props.accessLogsBucket.bucketName,
    description: "S3 bucket for ALB access logs",
  });
  new cdk.CfnOutput(scope, "EcsClusterName", {
    value: props.cluster.clusterName,
    description: "ECS cluster name",
  });
  new cdk.CfnOutput(scope, "EcsServiceName", {
    value: props.webService.serviceName,
    description: "ECS web service name",
  });
  new cdk.CfnOutput(scope, "MigrateTaskDefArn", {
    value: props.migrateTaskDef.taskDefinitionArn,
    description: "ECS task definition ARN for migrations",
  });
  new cdk.CfnOutput(scope, "MigrateSecurityGroupId", {
    value: props.migrateSg.securityGroupId,
    description: "Security group ID for migration tasks",
  });
  new cdk.CfnOutput(scope, "FxFetcherFunctionName", {
    value: props.fxFetcher.functionName,
    description: "Lambda function name for FX rate fetcher",
  });
  new cdk.CfnOutput(scope, "NlbDns", {
    value: props.nlb.loadBalancerDnsName,
    description: "NLB DNS name (for Cloudflare CNAME setup)",
  });
  new cdk.CfnOutput(scope, "DirectDbHost", {
    value: props.dbDomain,
    description: "User-facing hostname for direct DB access",
  });
}
