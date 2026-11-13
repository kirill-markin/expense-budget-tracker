import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface SecretsResult {
  sessionEncryptionKeySecret: cdk.aws_secretsmanager.Secret;
  openaiApiKeySecret: cdk.aws_secretsmanager.Secret;
  chatSandboxBridgeSecret: cdk.aws_secretsmanager.Secret;
  demoPasswordSecret: cdk.aws_secretsmanager.ISecret;
}

export function secrets(scope: Construct): SecretsResult {
  // OTP session signing key (HMAC-SHA256, 32 bytes = 64 hex chars).
  // Generates a 64-char lowercase hex string that passes the app's /^[0-9a-f]{64}$/ validation.
  const sessionEncryptionKeySecret = new cdk.aws_secretsmanager.Secret(scope, "SessionEncryptionKey", {
    secretName: "expense-tracker/session-encryption-key",
    generateSecretString: {
      passwordLength: 64,
      includeSpace: false,
      excludeUppercase: true,
      excludePunctuation: true,
      excludeCharacters: "ghijklmnopqrstuvwxyz",
      requireEachIncludedType: false,
    },
  });

  // AI API key secrets (user sets real values in Secrets Manager after deploy)
  const openaiApiKeySecret = new cdk.aws_secretsmanager.Secret(scope, "OpenAiApiKey", {
    secretName: "expense-tracker/openai-api-key",
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });

  // Signs the short-lived capability a chat sandbox command calls the web
  // app's SQL bridge with. Generated and owned by CDK: nothing outside the web
  // service ever needs its value.
  const chatSandboxBridgeSecret = new cdk.aws_secretsmanager.Secret(scope, "ChatSandboxBridgeSecret", {
    secretName: "expense-tracker/chat-sandbox-bridge-secret",
    generateSecretString: { excludePunctuation: true, passwordLength: 64 },
  });

  // Insecure shared password for demo/review @example.com accounts.
  // Used by E2E smoke tests to bypass OTP.
  // Pre-created manually in Secrets Manager — CDK references it but does not own it.
  const demoPasswordSecret = cdk.aws_secretsmanager.Secret.fromSecretNameV2(
    scope, "DemoPassword", "expense-tracker/demo-password",
  );

  return {
    sessionEncryptionKeySecret,
    openaiApiKeySecret,
    chatSandboxBridgeSecret,
    demoPasswordSecret,
  };
}
