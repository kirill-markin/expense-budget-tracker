import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_SANDBOX_SQL_CAPABILITY_TTL_MS,
  ChatSandboxSqlCapabilityError,
  mintChatSandboxSqlBridge,
  verifyChatSandboxSqlAuthorization,
  type ChatSandboxSqlCapability,
} from "./sqlCapability";

const SECRET = "a".repeat(64);
const NOW_MS = 1_800_000_000_000;

const CAPABILITY: ChatSandboxSqlCapability = {
  activeRunId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  userId: "user-1",
  workspaceId: "33333333-3333-4333-8333-333333333333",
};

const withEnv = (
  values: Readonly<Record<string, string | undefined>>,
  run: () => void,
): void => {
  const snapshot = Object.fromEntries(
    Object.keys(values).map((key): [string, string | undefined] => [key, process.env[key]]),
  );
  const apply = (next: Readonly<Record<string, string | undefined>>): void => {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        Reflect.set(process.env, key, value);
      }
    }
  };
  apply(values);
  try {
    run();
  } finally {
    apply(snapshot);
  }
};

const withBridgeEnv = (run: () => void): void =>
  withEnv({ CHAT_SANDBOX_BRIDGE_SECRET: SECRET, CORS_ORIGIN: "https://app.example.com" }, run);

const assertCapabilityError = (run: () => unknown, message: RegExp): void => {
  assert.throws(run, (error: unknown): boolean => {
    assert.ok(error instanceof ChatSandboxSqlCapabilityError);
    assert.match(error.message, message);
    return true;
  });
};

test("a minted capability verifies back to the run it names until it expires", (): void => {
  withBridgeEnv((): void => {
    const bridge = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);

    assert.equal(bridge.url, "https://app.example.com/api/chat/sandbox/sql");
    assert.match(bridge.authorization, /^ChatSandbox [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    assert.deepEqual(
      verifyChatSandboxSqlAuthorization(bridge.authorization, NOW_MS + CHAT_SANDBOX_SQL_CAPABILITY_TTL_MS - 1),
      CAPABILITY,
    );
    assertCapabilityError(
      () => verifyChatSandboxSqlAuthorization(bridge.authorization, NOW_MS + CHAT_SANDBOX_SQL_CAPABILITY_TTL_MS),
      /expired/u,
    );
  });
});

test("a capability whose payload or signature was changed is refused", (): void => {
  withBridgeEnv((): void => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const [encodedPayload, signature] = authorization.slice("ChatSandbox ".length).split(".");
    assert.ok(encodedPayload !== undefined && signature !== undefined);

    const otherUserPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>,
      userId: "user-2",
    }), "utf8").toString("base64url");
    const flippedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    assertCapabilityError(
      () => verifyChatSandboxSqlAuthorization(`ChatSandbox ${otherUserPayload}.${signature}`, NOW_MS),
      /signature is invalid/u,
    );
    assertCapabilityError(
      () => verifyChatSandboxSqlAuthorization(`ChatSandbox ${encodedPayload}.${flippedSignature}`, NOW_MS),
      /signature is invalid/u,
    );
  });
});

test("a capability signed with another secret is refused", (): void => {
  const authorization = ((): string => {
    let minted = "";
    withEnv({ CHAT_SANDBOX_BRIDGE_SECRET: "b".repeat(64), CORS_ORIGIN: "https://app.example.com" }, (): void => {
      minted = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS).authorization;
    });
    return minted;
  })();

  withBridgeEnv((): void => {
    assertCapabilityError(
      () => verifyChatSandboxSqlAuthorization(authorization, NOW_MS),
      /signature is invalid/u,
    );
  });
});

test("only the ChatSandbox scheme carries a capability", (): void => {
  withBridgeEnv((): void => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const token = authorization.slice("ChatSandbox ".length);

    assertCapabilityError(() => verifyChatSandboxSqlAuthorization(null, NOW_MS), /ChatSandbox authorization scheme/u);
    assertCapabilityError(() => verifyChatSandboxSqlAuthorization(`Bearer ${token}`, NOW_MS), /ChatSandbox authorization scheme/u);
    assertCapabilityError(() => verifyChatSandboxSqlAuthorization("ChatSandbox only-one-part", NOW_MS), /malformed/u);
  });
});

test("minting and verifying fail loudly without the bridge secret or origin", (): void => {
  withEnv({ CHAT_SANDBOX_BRIDGE_SECRET: undefined, CORS_ORIGIN: "https://app.example.com" }, (): void => {
    assert.throws(() => mintChatSandboxSqlBridge(CAPABILITY, NOW_MS), /CHAT_SANDBOX_BRIDGE_SECRET is required/u);
    assert.throws(() => verifyChatSandboxSqlAuthorization("ChatSandbox a.b", NOW_MS), /CHAT_SANDBOX_BRIDGE_SECRET is required/u);
  });
  withEnv({ CHAT_SANDBOX_BRIDGE_SECRET: "short", CORS_ORIGIN: "https://app.example.com" }, (): void => {
    assert.throws(() => mintChatSandboxSqlBridge(CAPABILITY, NOW_MS), /at least 32 characters/u);
  });
  withEnv({ CHAT_SANDBOX_BRIDGE_SECRET: SECRET, CORS_ORIGIN: undefined }, (): void => {
    assert.throws(() => mintChatSandboxSqlBridge(CAPABILITY, NOW_MS), /CORS_ORIGIN is required/u);
  });
});
