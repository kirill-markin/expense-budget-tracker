import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

export interface AuthProps {
  preSignUpFn: lambda.IFunction;
  customEmailSenderFn: lambda.IFunction;
  customEmailSenderKey: kms.Key;
}

export interface AuthResult {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

export function auth(scope: Construct, props: AuthProps): AuthResult {
  const userPool = new cognito.UserPool(scope, "UserPool", {
    userPoolName: "expense-tracker-users",
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    autoVerify: { email: true },
    customSenderKmsKey: props.customEmailSenderKey,
    keepOriginal: { email: true },
    lambdaTriggers: {
      preSignUp: props.preSignUpFn,
      customEmailSender: props.customEmailSenderFn,
    },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // Essentials tier required for USER_AUTH + EMAIL_OTP (no L2 support yet)
  const cfnUserPool = userPool.node.defaultChild as cdk.CfnResource;
  cfnUserPool.addPropertyOverride("UserPoolTier", "ESSENTIALS");
  cfnUserPool.addPropertyOverride("Policies.SignInPolicy.AllowedFirstAuthFactors", ["PASSWORD", "EMAIL_OTP"]);

  const userPoolClient = userPool.addClient("AppClient", {
    generateSecret: false,
    supportedIdentityProviders: [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ],
    refreshTokenValidity: cdk.Duration.days(35),
    // Rotation forbids ALLOW_REFRESH_TOKEN_AUTH; the grace period covers the
    // concurrent inline refreshes a single page load issues through the proxy
    refreshTokenRotationGracePeriod: cdk.Duration.seconds(60),
    // Non-empty allowlist denying `email`; an empty list means write-all.
    // `name` is unused by this repository and only keeps the list non-empty.
    // readAttributes stays unset so the ID token keeps email and email_verified
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
    enableTokenRevocation: true,
  });

  // CDK L2 doesn't expose USER_AUTH auth flow — override via L1
  (userPoolClient.node.defaultChild as cdk.CfnResource).addPropertyOverride(
    "ExplicitAuthFlows",
    ["ALLOW_USER_AUTH"],
  );

  return {
    userPool,
    userPoolClient,
  };
}
