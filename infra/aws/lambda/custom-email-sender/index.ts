import { CommitmentPolicy, buildClient, KmsKeyringNode } from "@aws-crypto/client-node";
import {
  GetSecretValueCommand,
  GetSecretValueCommandOutput,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createHash, randomUUID } from "node:crypto";

type CustomEmailSenderEvent = Readonly<{
  request: Readonly<{
    code?: string;
    userAttributes: Readonly<Record<string, string | undefined>>;
  }>;
  triggerSource: string;
  userName?: string;
}>;

type CustomEmailSenderEnvironment = Readonly<{
  keyArn: string;
  keyId: string;
  resendApiKeySecretArn: string;
  resendFromEmail: string;
  resendFromName: string;
}>;

type ResendEmailPayload = Readonly<{
  fromEmail: string;
  fromName: string;
  html: string;
  idempotencyKey: string;
  resendApiKey: string;
  subject: string;
  toEmail: string;
}>;

type CustomEmailSenderMessage = Readonly<{
  html: string;
  requiresCode: boolean;
  subject: string;
}>;

type ResendErrorMetadata = Readonly<{
  errorClassification: string | null;
  requestId: string | null;
}>;

type ResendErrorBody = Readonly<{
  name?: unknown;
  type?: unknown;
}>;

type ResendIdempotencyKeyFields = Readonly<{
  encryptedCodeHash: string | null;
  invocationId: string | null;
  subject: string;
  toEmailHash: string;
  triggerSource: string;
  userName: string | null;
  userSub: string | null;
}>;

type FetchFunction = typeof fetch;

type DecryptCodeFunction = (encryptedCode: string, keyId: string, keyArn: string) => Promise<string>;
type LoadResendApiKeyFunction = (secretArn: string) => Promise<string>;

type HandlerDependencies = Readonly<{
  decryptCode: DecryptCodeFunction;
  fetchFn: FetchFunction;
  loadResendApiKey: LoadResendApiKeyFunction;
}>;

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
const secretsManagerClient = new SecretsManagerClient({});
const resendMaxAttempts: number = 3;
const resendRetryDelayMs: number = 500;

function getRequiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function getEnvironment(): CustomEmailSenderEnvironment {
  return {
    keyArn: getRequiredEnvironmentValue("KEY_ARN"),
    keyId: getRequiredEnvironmentValue("KEY_ID"),
    resendApiKeySecretArn: getRequiredEnvironmentValue("RESEND_API_KEY_SECRET_ARN"),
    resendFromEmail: getRequiredEnvironmentValue("RESEND_FROM_EMAIL"),
    resendFromName: getRequiredEnvironmentValue("RESEND_FROM_NAME"),
  };
}

function getSecretString(secretValue: GetSecretValueCommandOutput, secretArn: string): string {
  if (secretValue.SecretString === undefined || secretValue.SecretString.trim() === "") {
    throw new Error(`Secrets Manager secret must contain a non-empty SecretString: secretArn=${secretArn}`);
  }

  return secretValue.SecretString.trim();
}

export async function getResendApiKeyFromSecretsManager(secretArn: string): Promise<string> {
  try {
    const secretValue = await secretsManagerClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    return getSecretString(secretValue, secretArn);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read Resend API key secret from Secrets Manager: secretArn=${secretArn}, error=${errorMessage}`,
      { cause: error },
    );
  }
}

function maskEmail(email: string): string {
  const [localPart, domainPart] = email.split("@");
  if (localPart === undefined || domainPart === undefined) {
    return "***";
  }

  if (localPart.length <= 2) {
    return `${localPart[0] ?? "*"}*@${domainPart}`;
  }

  return `${localPart[0]}***${localPart[localPart.length - 1]}@${domainPart}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeKnownHtmlEntity(entity: string): string {
  if (entity === "&amp;") {
    return "&";
  }

  if (entity === "&lt;") {
    return "<";
  }

  if (entity === "&gt;") {
    return ">";
  }

  if (entity === "&quot;") {
    return "\"";
  }

  if (entity === "&#39;" || entity === "&#x27;") {
    return "'";
  }

  if (entity === "&#x2F;") {
    return "/";
  }

  return entity;
}

function decodeKnownHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|#x27|#x2F);/g, decodeKnownHtmlEntity);
}

function getOptionalTrimmedValue(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function getSha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildResendIdempotencyKey(
  event: CustomEmailSenderEvent,
  toEmail: string,
  subject: string,
  invocationId: string | null,
): string {
  const encryptedCode = getOptionalTrimmedValue(event.request.code);
  if (encryptedCode === null && invocationId === null) {
    throw new Error("Resend idempotency key requires invocationId when Cognito event has no code");
  }

  const idempotencyFields: ResendIdempotencyKeyFields = {
    encryptedCodeHash: encryptedCode === null ? null : getSha256Hex(encryptedCode),
    invocationId: encryptedCode === null ? invocationId : null,
    subject,
    toEmailHash: getSha256Hex(toEmail.trim().toLowerCase()),
    triggerSource: event.triggerSource,
    userName: getOptionalTrimmedValue(event.userName),
    userSub: getOptionalTrimmedValue(event.request.userAttributes.sub),
  };

  return `cognito-custom-email-sender-${getSha256Hex(JSON.stringify(idempotencyFields))}`;
}

function buildOtpHtml(headline: string, code: string): string {
  const escapedCode = escapeHtml(code);
  const escapedHeadline = escapeHtml(headline);

  return [
    "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#111827\">",
    `<p>${escapedHeadline}</p>`,
    "<p style=\"margin:24px 0;font-size:32px;font-weight:700;letter-spacing:0.18em\">",
    escapedCode,
    "</p>",
    "<p>This code expires soon. If you did not request it, you can ignore this email.</p>",
    "</div>",
  ].join("");
}

function buildPlainHtml(message: string): string {
  return [
    "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5;color:#111827\">",
    `<p>${escapeHtml(message)}</p>`,
    "</div>",
  ].join("");
}

export function buildMessage(triggerSource: string, code: string | null): CustomEmailSenderMessage {
  if (triggerSource === "CustomEmailSender_Authentication") {
    if (code === null) {
      throw new Error("Authentication email requires a decrypted code");
    }

    return {
      subject: "Your Expense Budget Tracker sign-in code",
      html: buildOtpHtml("Use this sign-in code to continue in Expense Budget Tracker:", code),
      requiresCode: true,
    };
  }

  if (triggerSource === "CustomEmailSender_ForgotPassword") {
    if (code === null) {
      throw new Error("Forgot password email requires a decrypted code");
    }

    return {
      subject: "Your Expense Budget Tracker password reset code",
      html: buildOtpHtml("Use this password reset code for Expense Budget Tracker:", code),
      requiresCode: true,
    };
  }

  if (
    triggerSource === "CustomEmailSender_ResendCode"
    || triggerSource === "CustomEmailSender_SignUp"
    || triggerSource === "CustomEmailSender_UpdateUserAttribute"
    || triggerSource === "CustomEmailSender_VerifyUserAttribute"
  ) {
    if (code === null) {
      throw new Error(`${triggerSource} email requires a decrypted code`);
    }

    return {
      subject: "Your Expense Budget Tracker verification code",
      html: buildOtpHtml("Use this verification code for Expense Budget Tracker:", code),
      requiresCode: true,
    };
  }

  if (triggerSource === "CustomEmailSender_AdminCreateUser") {
    if (code === null) {
      throw new Error("Admin create user email requires a decrypted code");
    }

    const temporaryPassword = decodeKnownHtmlEntities(code);
    return {
      subject: "Your Expense Budget Tracker temporary password",
      html: buildPlainHtml(`Your temporary password for Expense Budget Tracker is: ${temporaryPassword}`),
      requiresCode: true,
    };
  }

  if (triggerSource === "CustomEmailSender_AccountTakeOverNotification") {
    return {
      subject: "Expense Budget Tracker security notice",
      html: buildPlainHtml(
        "Expense Budget Tracker detected suspicious activity on your account. Review your recent sign-in attempts.",
      ),
      requiresCode: false,
    };
  }

  throw new Error(`Unsupported Cognito custom email trigger source: ${triggerSource}`);
}

export async function decryptSecretCode(
  encryptedCode: string,
  keyId: string,
  keyArn: string,
): Promise<string> {
  const keyring = new KmsKeyringNode({
    generatorKeyId: keyId,
    keyIds: [keyArn],
  });
  const { plaintext } = await decrypt(keyring, Buffer.from(encryptedCode, "base64"));
  return Buffer.from(plaintext).toString("utf-8");
}

function parseResendErrorBody(responseText: string): ResendErrorBody | null {
  if (responseText.trim() === "") {
    return null;
  }

  try {
    const parsedBody: unknown = JSON.parse(responseText);
    if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return null;
    }

    return parsedBody as ResendErrorBody;
  } catch {
    return null;
  }
}

function isSafeShortErrorClassification(value: string): boolean {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0
    && trimmedValue.length <= 80
    && /[A-Za-z]/.test(trimmedValue)
    && /^[A-Za-z0-9._:-]+$/.test(trimmedValue);
}

function isSafeRequestId(value: string): boolean {
  const trimmedValue = value.trim();
  return trimmedValue.length >= 8
    && trimmedValue.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(trimmedValue);
}

function getSafeStringValue(value: unknown, isSafeValue: (stringValue: string) => boolean): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  if (!isSafeValue(trimmedValue)) {
    return null;
  }

  return trimmedValue;
}

function getSafeHeaderValue(headers: Headers, headerNames: readonly string[]): string | null {
  for (const headerName of headerNames) {
    const headerValue = headers.get(headerName);
    if (headerValue === null) {
      continue;
    }

    const safeHeaderValue = getSafeStringValue(headerValue, isSafeRequestId);
    if (safeHeaderValue !== null) {
      return safeHeaderValue;
    }
  }

  return null;
}

function getResendErrorMetadata(headers: Headers, responseText: string): ResendErrorMetadata {
  const parsedBody = parseResendErrorBody(responseText);
  const errorClassification = parsedBody === null
    ? null
    : getSafeStringValue(
      parsedBody.name,
      isSafeShortErrorClassification,
    ) ?? getSafeStringValue(
      parsedBody.type,
      isSafeShortErrorClassification,
    );
  const requestId = getSafeHeaderValue(headers, [
    "x-request-id",
    "x-resend-request-id",
    "resend-request-id",
    "cf-ray",
  ]);

  return {
    errorClassification,
    requestId,
  };
}

function formatResendFailureMessage(statusCode: number, errorMetadata: ResendErrorMetadata): string {
  const metadataFields: string[] = [`statusCode=${statusCode}`];
  if (errorMetadata.errorClassification !== null) {
    metadataFields.push(`errorClassification=${errorMetadata.errorClassification}`);
  }

  if (errorMetadata.requestId !== null) {
    metadataFields.push(`requestId=${errorMetadata.requestId}`);
  }

  return `Resend email send failed: ${metadataFields.join(", ")}`;
}

export async function sendResendEmail(
  payload: ResendEmailPayload,
  fetchFn: FetchFunction,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt: number = 1; attempt <= resendMaxAttempts; attempt += 1) {
    try {
      const response = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${payload.resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": payload.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${payload.fromName} <${payload.fromEmail}>`,
          to: [payload.toEmail],
          subject: payload.subject,
          html: payload.html,
        }),
      });

      if (response.ok) {
        const responseBody = await response.json() as Readonly<{ id?: string }>;
        console.log(JSON.stringify({
          domain: "auth",
          action: "custom_email_sender_send",
          attempt,
          maskedEmail: maskEmail(payload.toEmail),
          resendEmailId: responseBody.id ?? null,
          statusCode: response.status,
          subject: payload.subject,
        }));
        return;
      }

      const responseText = await response.text();
      const errorMetadata = getResendErrorMetadata(response.headers, responseText);
      lastError = new Error(formatResendFailureMessage(response.status, errorMetadata));
      if (attempt < resendMaxAttempts && isRetryableResendStatus(response.status)) {
        console.warn(JSON.stringify({
          domain: "auth",
          action: "custom_email_sender_send_retry",
          attempt,
          errorClassification: errorMetadata.errorClassification,
          maskedEmail: maskEmail(payload.toEmail),
          maxAttempts: resendMaxAttempts,
          requestId: errorMetadata.requestId,
          statusCode: response.status,
          subject: payload.subject,
        }));
        await wait(resendRetryDelayMs);
        continue;
      }

      console.error(JSON.stringify({
        domain: "auth",
        action: "custom_email_sender_send_error",
        attempt,
        errorClassification: errorMetadata.errorClassification,
        maskedEmail: maskEmail(payload.toEmail),
        requestId: errorMetadata.requestId,
        statusCode: response.status,
        subject: payload.subject,
      }));
      throw lastError;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.startsWith("Resend email send failed: ")) {
        throw lastError;
      }

      if (attempt >= resendMaxAttempts) {
        console.error(JSON.stringify({
          domain: "auth",
          action: "custom_email_sender_send_error",
          attempt,
          errorMessage: lastError.message,
          maskedEmail: maskEmail(payload.toEmail),
          maxAttempts: resendMaxAttempts,
          subject: payload.subject,
        }));
        throw lastError;
      }

      console.warn(JSON.stringify({
        domain: "auth",
        action: "custom_email_sender_send_retry",
        attempt,
        errorMessage: lastError.message,
        maskedEmail: maskEmail(payload.toEmail),
        maxAttempts: resendMaxAttempts,
        subject: payload.subject,
      }));
      await wait(resendRetryDelayMs);
    }
  }

  throw lastError ?? new Error("Resend email send failed without an error");
}

function isRetryableResendStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function handleCustomEmailSenderEvent(
  event: CustomEmailSenderEvent,
  environment: CustomEmailSenderEnvironment,
  dependencies: HandlerDependencies,
): Promise<CustomEmailSenderEvent> {
  const email = event.request.userAttributes.email;
  if (email === undefined || email.trim() === "") {
    throw new Error("Custom email sender event is missing request.userAttributes.email");
  }

  const message = buildMessage(event.triggerSource, event.request.code === undefined ? null : "");
  const decryptedCode = message.requiresCode
    ? await dependencies.decryptCode(
      event.request.code ?? "",
      environment.keyId,
      environment.keyArn,
    )
    : null;
  const resolvedMessage = buildMessage(event.triggerSource, decryptedCode);
  const resendApiKey = await dependencies.loadResendApiKey(environment.resendApiKeySecretArn);
  const idempotencyInvocationId = getOptionalTrimmedValue(event.request.code) === null ? randomUUID() : null;
  const idempotencyKey = buildResendIdempotencyKey(
    event,
    email,
    resolvedMessage.subject,
    idempotencyInvocationId,
  );

  await sendResendEmail({
    fromEmail: environment.resendFromEmail,
    fromName: environment.resendFromName,
    html: resolvedMessage.html,
    idempotencyKey,
    resendApiKey,
    subject: resolvedMessage.subject,
    toEmail: email,
  }, dependencies.fetchFn);

  return event;
}

export async function handler(event: CustomEmailSenderEvent): Promise<CustomEmailSenderEvent> {
  return handleCustomEmailSenderEvent(event, getEnvironment(), {
    decryptCode: decryptSecretCode,
    fetchFn: fetch,
    loadResendApiKey: getResendApiKeyFromSecretsManager,
  });
}
