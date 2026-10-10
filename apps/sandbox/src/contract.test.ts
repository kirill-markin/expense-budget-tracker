import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChatSandboxBashRequest,
  SANDBOX_FILE_MAX_BYTES,
  SANDBOX_OBJECT_HOSTS_ENV_VAR,
} from "./contract.js";

const ALLOWED_HOST = "chat-files.s3.eu-central-1.amazonaws.com";

/** The shape chat_sessions.session_id holds, which is the only one accepted. */
const SESSION_ID = "0f1e2d3c-4b5a-4968-8776-65544332211f";

type FileOverrides = Readonly<{
  path?: string;
  sizeBytes?: number;
  getUrl?: string;
}>;

const file = (overrides: FileOverrides): unknown => ({
  path: "/work/a.csv",
  sizeBytes: 3,
  mediaType: "text/csv",
  sha256: "a".repeat(64),
  mtimeMs: 1_700_000_000_000,
  getUrl: `https://${ALLOWED_HOST}/sessions/s1/a`,
  ...overrides,
});

type RequestOverrides = Readonly<{
  sessionId?: unknown;
  files?: ReadonlyArray<unknown>;
  writeSlots?: ReadonlyArray<unknown>;
}>;

const request = (overrides: RequestOverrides): unknown => ({
  operation: "bash",
  sessionId: SESSION_ID,
  command: "echo hi",
  files: [file({})],
  writeSlots: [{ slotId: "slot-0", putUrl: `https://${ALLOWED_HOST}/sessions/s1/slot-0` }],
  ...overrides,
});

const withAllowedHosts = (hosts: string, run: () => void): void => {
  const previous = process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR];
  process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR] = hosts;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR];
    } else {
      process.env[SANDBOX_OBJECT_HOSTS_ENV_VAR] = previous;
    }
  }
};

test("a request on an allowed object host is accepted", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    const parsed = parseChatSandboxBashRequest(request({}));
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.writeSlots.length, 1);
  });
});

// The function has no VPC, so unrestricted egress makes the URL allowlist the
// only thing standing between a hostile payload and an arbitrary HTTPS host.
test("a pre-signed URL outside the allowlist is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: [file({ getUrl: "https://attacker.example/x" })] })),
      /not one of the object-storage hosts/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({
        writeSlots: [{ slotId: "slot-0", putUrl: "https://attacker.example/x" }],
      })),
      /not one of the object-storage hosts/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({
        files: [file({ getUrl: `https://${ALLOWED_HOST}@attacker.example/x` })],
      })),
      /does not match its schema/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: [file({ getUrl: `http://${ALLOWED_HOST}/x` })] })),
      /does not match its schema/,
    );
  });
});

test("without a host allowlist no request is accepted", (): void => {
  withAllowedHosts("  ", () => {
    assert.throws(
      () => parseChatSandboxBashRequest(request({})),
      new RegExp(`${SANDBOX_OBJECT_HOSTS_ENV_VAR} is not set`),
    );
  });
});

test("a file set the two mounts cannot represent is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    assert.throws(
      () => parseChatSandboxBashRequest(request({
        files: [file({ path: "/work/a" }), file({ path: "/work/a/b" })],
      })),
      /both as a file and as the parent directory/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: [file({}), file({})] })),
      /repeats the path/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({
        writeSlots: [
          { slotId: "slot-0", putUrl: `https://${ALLOWED_HOST}/one` },
          { slotId: "slot-0", putUrl: `https://${ALLOWED_HOST}/two` },
        ],
      })),
      /repeats the slotId/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: [file({ path: "/work/../etc/passwd" })] })),
      /does not match its schema/,
    );
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: [file({ path: "/etc/passwd" })] })),
      /does not match its schema/,
    );
  });
});

/** Files just inside the per-file bound, so only the aggregate can refuse them. */
const largeFiles = (mount: string, count: number): ReadonlyArray<unknown> =>
  Array.from({ length: count }, (_unused, index) => file({
    path: `${mount}/f${String(index)}.bin`,
    sizeBytes: SANDBOX_FILE_MAX_BYTES,
  }));

test("a /work set larger than one command may seed is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    // Six files of 100 MB: each legal on its own, 629145600 bytes together.
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: largeFiles("/work", 6) })),
      /\/work would hold 629145600 bytes, past the 536870912 byte limit/,
    );
    // Five of them fit, so the refusal is the aggregate and not the per-file bound.
    assert.equal(parseChatSandboxBashRequest(request({ files: largeFiles("/work", 5) })).files.length, 5);
  });
});

// The converse of the governing invariant: anything the sandbox accepts back,
// it must be able to re-save. A file over the per-file bound was seedable and
// then refused on every attempt to modify it, freezing it with no way out.
test("a file larger than one command may save is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    for (const mount of ["/work", "/files"]) {
      assert.throws(
        () => parseChatSandboxBashRequest(request({
          files: [file({ path: `${mount}/big.bin`, sizeBytes: SANDBOX_FILE_MAX_BYTES + 1 })],
        })),
        /104857601 bytes exceeds the 104857600 byte limit for one stored file/,
        `${mount} must refuse a file past the per-file bound`,
      );
    }
    assert.equal(
      parseChatSandboxBashRequest(request({
        files: [file({ path: "/work/big.bin", sizeBytes: SANDBOX_FILE_MAX_BYTES })],
      })).files.length,
      1,
    );
  });
});

// /files is read into memory and never evicted, so without an aggregate ceiling
// a `grep -r /files` over enough originals exhausts the function and the kernel
// kills the process serving the chat session mid-command. Each mount is counted
// on its own: a /files set at its own ceiling must not be refused for /work.
test("a /files set larger than one command may read is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    assert.throws(
      () => parseChatSandboxBashRequest(request({ files: largeFiles("/files", 6) })),
      /\/files files total 629145600 bytes/,
    );

    // Each mount is counted on its own, so a /files set at its own ceiling must
    // not be refused because of /work, or the other way round.
    const bothAtTheirCeiling = parseChatSandboxBashRequest(request({
      files: [...largeFiles("/files", 5), ...largeFiles("/work", 5)],
    }));
    assert.equal(bothAtTheirCeiling.files.length, 10);
  });
});

// One session id is one child process, so a caller that reused an id across two
// chats would serve both from one process. The sandbox cannot tell that from
// correct use, so it refuses anything that is not the id it expects.
test("a sessionId that is not a chat session id is refused", (): void => {
  withAllowedHosts(ALLOWED_HOST, () => {
    for (const sessionId of ["s1", "", `${SESSION_ID} `, SESSION_ID.toUpperCase(), 7]) {
      assert.throws(
        () => parseChatSandboxBashRequest(request({ sessionId })),
        /does not match its schema/,
        `sessionId ${JSON.stringify(sessionId)} must be refused`,
      );
    }
    assert.equal(parseChatSandboxBashRequest(request({})).sessionId, SESSION_ID);
  });
});

// The URL parser drops an explicit default port, so the two sides of the
// comparison have to be normalized the same way or an allowlist spelled with
// one would match nothing at all.
test("the host allowlist and the URL agree on a default port", (): void => {
  withAllowedHosts(`${ALLOWED_HOST}:443`, () => {
    const parsed = parseChatSandboxBashRequest(request({
      files: [file({ getUrl: `https://${ALLOWED_HOST}/sessions/s1/a` })],
    }));
    assert.equal(parsed.files.length, 1);
  });
  withAllowedHosts(ALLOWED_HOST, () => {
    const parsed = parseChatSandboxBashRequest(request({
      files: [file({ getUrl: `https://${ALLOWED_HOST}:443/sessions/s1/a` })],
    }));
    assert.equal(parsed.files.length, 1);
  });
  // A non-default port still has to match, and an entry that is not a host at
  // all is an operator error rather than an allowlist that quietly matches
  // nothing.
  withAllowedHosts("localhost:9000", () => {
    const onPort = {
      files: [file({ getUrl: "https://localhost:9000/a" })],
      writeSlots: [{ slotId: "slot-0", putUrl: "https://localhost:9000/slot-0" }],
    };
    assert.equal(parseChatSandboxBashRequest(request(onPort)).files.length, 1);
    assert.throws(
      () => parseChatSandboxBashRequest(request({
        ...onPort,
        files: [file({ getUrl: "https://localhost/a" })],
      })),
      /not one of the object-storage hosts/,
    );
  });
  withAllowedHosts("https://bucket.example/prefix", () => {
    assert.throws(
      () => parseChatSandboxBashRequest(request({})),
      /carries more than a host and a port/,
    );
  });
});
