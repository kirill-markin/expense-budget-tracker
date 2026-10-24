import * as path from "node:path";
import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Construct } from "constructs";
import { CHAT_SANDBOX_RESERVED_CONCURRENCY } from "./chat-sandbox";
import { MCP_CAPACITY_BUDGET, MCP_TIMEOUT_BUDGET } from "./mcp-gateway";

const LAMBDA_NODE_IMAGE_BASES: Readonly<Record<"amd64" | "arm64", string>> = JSON.parse(
  readFileSync(path.join(__dirname, "../lambda-images/bases.json"), "utf8"),
);

export type LambdaImageCandidateName = "fx" | "authorizer" | "api" | "mcp" | "sandbox" | "signup" | "email";
export type LambdaImageCodeFactory = (name: LambdaImageCandidateName) => lambda.DockerImageCode;

export const lambdaImageCode: LambdaImageCodeFactory = (name) => {
  const arm = name === "sandbox";
  return lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "../../.."), {
    file: "infra/aws/lambda-images/Dockerfile",
    platform: arm ? Platform.LINUX_ARM64 : Platform.LINUX_AMD64,
    buildArgs: { AWS_NODE_BASE: LAMBDA_NODE_IMAGE_BASES[arm ? "arm64" : "amd64"], FUNCTION: name },
    cmd: ["index.handler"],
    ignoreMode: cdk.IgnoreMode.DOCKER,
  });
};

export interface LambdaImageCandidatesProps {
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  appDbSecret: secretsmanager.Secret;
  workerDbSecret: secretsmanager.Secret;
  chatFilesBucket: s3.Bucket;
  customEmailSenderKey: kms.Key;
  resendApiKeySecretArn: string;
  resendSenderEmail: string;
  baseDomain: string;
}

export const lambdaImageCandidates = (
  scope: Construct,
  props: LambdaImageCandidatesProps,
  createCode: LambdaImageCodeFactory,
): ReadonlyArray<lambda.DockerImageFunction> => {
  const dbNetwork = {
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.lambdaSg],
  };
  const dbEnvironment = {
    NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
    DB_HOST: props.db.dbInstanceEndpointAddress,
    DB_NAME: "tracker",
  };
  const create = (
    name: LambdaImageCandidateName,
    options: lambda.FunctionOptions,
  ): lambda.DockerImageFunction => {
    const fn = new lambda.DockerImageFunction(scope, `LambdaImageCandidate${name}`, {
      ...options,
      code: createCode(name),
      architecture: name === "sandbox" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
    });
    new cdk.CfnOutput(scope, `LambdaImageCandidate${name}Arn`, { value: fn.functionArn });
    return fn;
  };
  const fx = create("fx", {
    ...dbNetwork,
    timeout: cdk.Duration.minutes(5),
    memorySize: 256,
    environment: { ...dbEnvironment, DB_SECRET_ARN: props.workerDbSecret.secretArn },
  });
  props.workerDbSecret.grantRead(fx);
  const authorizer = create("authorizer", {
    ...dbNetwork,
    timeout: cdk.Duration.seconds(10),
    memorySize: 256,
    environment: { ...dbEnvironment, DB_SECRET_ARN: props.appDbSecret.secretArn },
  });
  const api = create("api", {
    ...dbNetwork,
    timeout: cdk.Duration.seconds(35),
    memorySize: 256,
    environment: {
      ...dbEnvironment,
      DB_SECRET_ARN: props.appDbSecret.secretArn,
      PUBLIC_API_BASE_URL: `https://api.${props.baseDomain}/v1`,
      PUBLIC_AUTH_BASE_URL: `https://auth.${props.baseDomain}`,
    },
  });
  const mcp = create("mcp", {
    ...dbNetwork,
    timeout: cdk.Duration.seconds(MCP_TIMEOUT_BUDGET.lambdaSeconds),
    memorySize: 256,
    reservedConcurrentExecutions: MCP_CAPACITY_BUDGET.reservedConcurrentExecutions,
    environment: {
      ...dbEnvironment,
      DB_SECRET_ARN: props.appDbSecret.secretArn,
      OAUTH_ISSUER: `https://auth.${props.baseDomain}`,
      OAUTH_RESOURCE: `https://mcp.${props.baseDomain}/mcp`,
    },
  });
  for (const fn of [authorizer, api, mcp]) props.appDbSecret.grantRead(fn);
  const sandbox = create("sandbox", {
    memorySize: 10240,
    timeout: cdk.Duration.minutes(2),
    reservedConcurrentExecutions: CHAT_SANDBOX_RESERVED_CONCURRENCY,
    environment: {
      NODE_OPTIONS: "--max-old-space-size=6144",
      CHAT_SANDBOX_OBJECT_HOSTS: props.chatFilesBucket.bucketRegionalDomainName,
    },
  });
  const signup = create("signup", {
    description: "Auto-confirm user and verify email on sign-up (image candidate)",
  });
  const email = create("email", {
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: {
      KEY_ARN: props.customEmailSenderKey.keyArn,
      KEY_ID: props.customEmailSenderKey.keyId,
      RESEND_API_KEY_SECRET_ARN: props.resendApiKeySecretArn,
      RESEND_FROM_EMAIL: props.resendSenderEmail,
      RESEND_FROM_NAME: "Expense Budget Tracker",
    },
  });
  props.customEmailSenderKey.grantDecrypt(email);
  secretsmanager.Secret.fromSecretCompleteArn(scope, "CandidateResendApiKeySecret", props.resendApiKeySecretArn).grantRead(email);
  return [fx, authorizer, api, mcp, sandbox, signup, email];
};
