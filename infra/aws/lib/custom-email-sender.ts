import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface SecretArnParts {
  region: string;
  account: string;
}

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

export function customEmailSenderKey(
  scope: Construct,
  resendApiKeySecretArn: string,
): kms.Key {
  validateSecretArnMatchesStack(scope, resendApiKeySecretArn);

  const kmsKey = new kms.Key(scope, "CustomEmailSenderKey", {
    alias: "expense-tracker-cognito-custom-email-sender",
    enableKeyRotation: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  allowCloudFormationExecutionRoleToCreateCognitoGrant(kmsKey);

  return kmsKey;
}
