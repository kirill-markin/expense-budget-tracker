import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The capability the code of one `bash` command calls the chat's SQL tools
 * with: it names one chat run of one user and session workspace and expires
 * within minutes, and the bridge route also requires that run to still be the
 * session's running run, so a stopped or finished run's sandbox is refused.
 * Its key is derived for this purpose alone from the bridge secret, so a token
 * minted for any other use of that secret never verifies here.
 */

export const CHAT_SANDBOX_BRIDGE_SECRET_ENV_VAR = "CHAT_SANDBOX_BRIDGE_SECRET";
export const CHAT_SANDBOX_SQL_ROUTE_PATH = "/api/chat/sandbox/sql";

const CAPABILITY_VERSION = 1;
const SIGNING_KEY_LABEL = "chat-sandbox-sql-v1";
/** One command fits the sandbox Lambda's timeout, with room for the invoke to queue. */
export const CHAT_SANDBOX_SQL_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const AUTHORIZATION_SCHEME = "ChatSandbox ";
const MIN_SECRET_LENGTH = 32;

const capabilityPayloadSchema = z.object({
  version: z.literal(CAPABILITY_VERSION),
  activeRunId: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  expiresAt: z.number().int(),
}).strict();

type CapabilityPayload = z.infer<typeof capabilityPayloadSchema>;

export type ChatSandboxSqlCapability = Readonly<{
  activeRunId: string;
  sessionId: string;
  userId: string;
  /** The session's workspace; a statement may still name another accessible one. */
  workspaceId: string;
}>;

/** What the sandbox needs to call the bridge: where, and the header to send. */
export type ChatSandboxSqlBridge = Readonly<{
  url: string;
  authorization: string;
}>;

export class ChatSandboxSqlCapabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatSandboxSqlCapabilityError";
  }
}

const readSigningKey = (): Buffer => {
  const secret = process.env[CHAT_SANDBOX_BRIDGE_SECRET_ENV_VAR];
  if (secret === undefined || secret === "") {
    throw new Error(`${CHAT_SANDBOX_BRIDGE_SECRET_ENV_VAR} is required to mint or verify a chat sandbox SQL capability`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${CHAT_SANDBOX_BRIDGE_SECRET_ENV_VAR} must be at least ${String(MIN_SECRET_LENGTH)} characters, got ${String(secret.length)}`);
  }

  return createHmac("sha256", secret).update(SIGNING_KEY_LABEL).digest();
};

const signPayload = (encodedPayload: string, key: Buffer): string =>
  createHmac("sha256", key).update(encodedPayload).digest("base64url");

/** The app's public origin: the sandbox runs in no VPC and reaches it over the internet. */
const readBridgeUrl = (): string => {
  const origin = process.env.CORS_ORIGIN;
  if (origin === undefined || origin === "") {
    throw new Error("CORS_ORIGIN is required to build the chat sandbox SQL bridge URL");
  }

  return `${origin}${CHAT_SANDBOX_SQL_ROUTE_PATH}`;
};

const decodePayload = (encodedPayload: string): CapabilityPayload => {
  try {
    return capabilityPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
  } catch {
    throw new ChatSandboxSqlCapabilityError("The chat sandbox SQL capability payload is invalid");
  }
};

export const mintChatSandboxSqlBridge = (
  capability: ChatSandboxSqlCapability,
  nowMs: number,
): ChatSandboxSqlBridge => {
  const payload: CapabilityPayload = {
    version: CAPABILITY_VERSION,
    activeRunId: capability.activeRunId,
    sessionId: capability.sessionId,
    userId: capability.userId,
    workspaceId: capability.workspaceId,
    expiresAt: nowMs + CHAT_SANDBOX_SQL_CAPABILITY_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signPayload(encodedPayload, readSigningKey());
  return {
    url: readBridgeUrl(),
    authorization: `${AUTHORIZATION_SCHEME}${encodedPayload}.${signature}`,
  };
};

export const verifyChatSandboxSqlAuthorization = (
  authorizationHeader: string | null,
  nowMs: number,
): ChatSandboxSqlCapability => {
  if (authorizationHeader === null || !authorizationHeader.startsWith(AUTHORIZATION_SCHEME)) {
    throw new ChatSandboxSqlCapabilityError("The chat sandbox SQL capability must be sent with the ChatSandbox authorization scheme");
  }

  const parts = authorizationHeader.slice(AUTHORIZATION_SCHEME.length).split(".");
  const encodedPayload = parts[0];
  const providedSignature = parts[1];
  if (
    parts.length !== 2
    || encodedPayload === undefined
    || providedSignature === undefined
    || encodedPayload === ""
    || providedSignature === ""
  ) {
    throw new ChatSandboxSqlCapabilityError("The chat sandbox SQL capability is malformed");
  }

  // Compared as the exact encoded text, so no alternative encoding of the same
  // bytes passes.
  const expected = Buffer.from(signPayload(encodedPayload, readSigningKey()), "utf8");
  const provided = Buffer.from(providedSignature, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ChatSandboxSqlCapabilityError("The chat sandbox SQL capability signature is invalid");
  }

  const payload = decodePayload(encodedPayload);
  if (payload.expiresAt <= nowMs) {
    throw new ChatSandboxSqlCapabilityError("The chat sandbox SQL capability expired");
  }

  return {
    activeRunId: payload.activeRunId,
    sessionId: payload.sessionId,
    userId: payload.userId,
    workspaceId: payload.workspaceId,
  };
};
