import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "path";

export interface CustomEmailSenderProps {
  resendApiKeySecretArn: string;
  resendSenderEmail: string;
}

export interface CustomEmailSenderResult {
  fn: lambdaNodejs.NodejsFunction;
  kmsKey: kms.Key;
}

interface SecretArnParts {
  region: string;
  account: string;
}

const bundling: lambdaNodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
};

const secretArnPattern: RegExp = /^arn:[^:]+:secretsmanager:([^:]+):(\d{12}):secret:.+$/;

function parseSecretArn(secretArn: string): SecretArnParts {
  const match: RegExpMatchArray | null = secretArn.match(secretArnPattern);
  if (match === null) {
    throw new Error(
      `Invalid resendApiKeySecretArn: expected a complete Secrets Manager secret ARN with account and region, got "${secretArn}"`,
    );
  }

  return {
    region: match[1],
    account: match[2],
  };
}

function validateSecretArnMatchesStack(scope: Construct, secretArn: string): void {
  const stack = cdk.Stack.of(scope);
  const arnParts = parseSecretArn(secretArn);

  if (cdk.Token.isUnresolved(stack.account)) {
    throw new Error(
      `Cannot validate resendApiKeySecretArn account "${arnParts.account}" because stack account is unresolved`,
    );
  }

  if (cdk.Token.isUnresolved(stack.region)) {
    throw new Error(
      `Cannot validate resendApiKeySecretArn region "${arnParts.region}" because stack region is unresolved`,
    );
  }

  if (arnParts.account !== stack.account) {
    throw new Error(
      `Invalid resendApiKeySecretArn account: expected stack account "${stack.account}", got "${arnParts.account}"`,
    );
  }

  if (arnParts.region !== stack.region) {
    throw new Error(
      `Invalid resendApiKeySecretArn region: expected stack region "${stack.region}", got "${arnParts.region}"`,
    );
  }
}

function allowCloudFormationExecutionRoleToCreateCognitoGrant(kmsKey: kms.Key): void {
  const stack = cdk.Stack.of(kmsKey);
  const cloudFormationExecutionRoleArn = stack.formatArn({
    service: "iam",
    region: "",
    account: stack.account,
    resource: "role",
    resourceName: [
      "cdk",
      cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER,
      "cfn-exec-role",
      stack.account,
      stack.region,
    ].join("-"),
  });

  // Cognito creates this grant while the user pool is being created, before
  // userPool.userPoolId can be used by a dependent custom resource.
  kmsKey.addToResourcePolicy(new iam.PolicyStatement({
    sid: "AllowCloudFormationCreateCognitoSenderGrant",
    principals: [new iam.ArnPrincipal(cloudFormationExecutionRoleArn)],
    actions: ["kms:CreateGrant"],
    resources: ["*"],
    conditions: {
      Bool: {
        "kms:GrantIsForAWSResource": "true",
      },
      StringLike: {
        "kms:EncryptionContext:userpool-id": `${stack.region}_*`,
      },
    },
  }));
}

export function customEmailSender(
  scope: Construct,
  props: CustomEmailSenderProps,
): CustomEmailSenderResult {
  validateSecretArnMatchesStack(scope, props.resendApiKeySecretArn);

  const kmsKey = new kms.Key(scope, "CustomEmailSenderKey", {
    alias: "expense-tracker-cognito-custom-email-sender",
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  allowCloudFormationExecutionRoleToCreateCognitoGrant(kmsKey);

  const resendApiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    "ResendApiKeySecret",
    props.resendApiKeySecretArn,
  );

  const fn = new lambdaNodejs.NodejsFunction(scope, "CustomEmailSenderFn", {
    entry: path.join(__dirname, "../lambda/custom-email-sender/index.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    bundling,
    environment: {
      KEY_ARN: kmsKey.keyArn,
      KEY_ID: kmsKey.keyId,
      RESEND_API_KEY_SECRET_ARN: props.resendApiKeySecretArn,
      RESEND_FROM_EMAIL: props.resendSenderEmail,
      RESEND_FROM_NAME: "Expense Budget Tracker",
    },
  });

  kmsKey.grantDecrypt(fn);
  resendApiKeySecret.grantRead(fn);

  return {
    fn,
    kmsKey,
  };
}
