import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface SecretsResult {
  sessionEncryptionKeySecret: cdk.aws_secretsmanager.Secret;
  openaiApiKeySecret: cdk.aws_secretsmanager.Secret;
  anthropicApiKeySecret: cdk.aws_secretsmanager.Secret;
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

  const anthropicApiKeySecret = new cdk.aws_secretsmanager.Secret(scope, "AnthropicApiKey", {
    secretName: "expense-tracker/anthropic-api-key",
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });

  return { sessionEncryptionKeySecret, openaiApiKeySecret, anthropicApiKeySecret };
}
