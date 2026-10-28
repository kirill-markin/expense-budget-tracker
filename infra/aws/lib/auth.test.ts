import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { auth } from "./auth";

const REFRESH_TOKEN_VALIDITY_MINUTES: number = cdk.Duration.days(35).toMinutes();

const synthesizeAuthTemplate = (): Template => {
  const stack = new cdk.Stack(new cdk.App(), "AuthTest", {
    env: { account: "123456789012", region: "eu-central-1" },
  });
  const trigger = (id: string): lambda.Function => new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async (event) => event;"),
  });
  auth(stack, {
    preSignUpFn: trigger("PreSignUp"),
    customEmailSenderFn: trigger("CustomEmailSender"),
    customEmailSenderKey: new kms.Key(stack, "CustomEmailSenderKey"),
  });
  return Template.fromStack(stack);
};

/**
 * The app client's own access token must not be able to write `email`. Cognito
 * treats an empty WriteAttributes list as the write-all default, so the
 * allowlist has to stay non-empty, and ReadAttributes has to stay absent for
 * the ID token to keep carrying `email` and `email_verified`.
 */
test("the app client can write no attribute but the inert name placeholder", (): void => {
  const clients = Object.values(synthesizeAuthTemplate().findResources("AWS::Cognito::UserPoolClient"));

  assert.equal(clients.length, 1);
  const writeAttributes: ReadonlyArray<string> = clients[0].Properties.WriteAttributes;
  assert.deepEqual(writeAttributes, ["name"]);
  assert.ok(writeAttributes.length > 0);
  assert.equal(writeAttributes.includes("email"), false);
  assert.equal(clients[0].Properties.ReadAttributes, undefined);
});

test("the app client only allows USER_AUTH, so rotation stays permitted", (): void => {
  synthesizeAuthTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
    ExplicitAuthFlows: ["ALLOW_USER_AUTH"],
  });
});

test("app client refresh tokens expire in 35 days and rotate with a 60 second grace period", (): void => {
  synthesizeAuthTemplate().hasResourceProperties("AWS::Cognito::UserPoolClient", {
    RefreshTokenValidity: REFRESH_TOKEN_VALIDITY_MINUTES,
    TokenValidityUnits: Match.objectLike({ RefreshToken: "minutes" }),
    RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 60 },
  });
});

test("the user pool keeps the original email until a new one is verified", (): void => {
  synthesizeAuthTemplate().hasResourceProperties("AWS::Cognito::UserPool", {
    UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ["email"] },
  });
});

/**
 * EMAIL_OTP as a first auth factor requires the Essentials tier, so a CDK
 * upgrade that drops either property silently disables passwordless sign-in.
 * `Policies` is now rendered by the L2 construct, so a CDK release that starts
 * emitting a default PasswordPolicy would push an unintended change onto the
 * retained production pool; the absence assertion catches that.
 */
test("the user pool runs the Essentials tier and accepts password or email OTP sign-in", (): void => {
  synthesizeAuthTemplate().hasResourceProperties("AWS::Cognito::UserPool", {
    UserPoolTier: "ESSENTIALS",
    Policies: {
      SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] },
      PasswordPolicy: Match.absent(),
    },
  });
});
