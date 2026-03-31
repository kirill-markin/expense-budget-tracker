import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface SecretsResult {
  sessionEncryptionKeySecret: cdk.aws_secretsmanager.Secret;
  openaiApiKeySecret: cdk.aws_secretsmanager.Secret;
  langfusePublicKeySecret: cdk.aws_secretsmanager.Secret;
  langfuseSecretKeySecret: cdk.aws_secretsmanager.Secret;
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

  const langfusePublicKeySecret = new cdk.aws_secretsmanager.Secret(scope, "LangfusePublicKey", {
    secretName: "expense-tracker/langfuse-public-key",
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });

  const langfuseSecretKeySecret = new cdk.aws_secretsmanager.Secret(scope, "LangfuseSecretKey", {
    secretName: "expense-tracker/langfuse-secret-key",
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
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
    langfusePublicKeySecret,
    langfuseSecretKeySecret,
    demoPasswordSecret,
  };
}
