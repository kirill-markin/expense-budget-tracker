import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { z } from "zod";
import { runChatSandboxBash } from "./bashOperation.js";
import {
  SANDBOX_MAX_SQL_CALLS_PER_COMMAND,
  type ChatSandboxBashResponse,
  type ChatSandboxSqlBridge,
} from "./contract.js";
import { SQL_BRIDGE_USER_AGENT } from "./sqlBridge.js";

type BridgeAnswer = Readonly<{ status: number; body: string }>;

const bridgeBodySchema = z.object({
  kind: z.enum(["query", "execute"]),
  sql: z.string(),
  workspaceId: z.string().nullable(),
}).strict();

type ReceivedCall = Readonly<{
  authorization: string | undefined;
  userAgent: string | undefined;
  body: z.infer<typeof bridgeBodySchema>;
}>;

type FakeBridge = Readonly<{
  bridge: ChatSandboxSqlBridge;
  calls: Array<ReceivedCall>;
  close: () => Promise<void>;
}>;

const AUTHORIZATION = "ChatSandbox payload.signature";

const BRIDGE_HOST = "127.0.0.1";

const okEnvelope = (data: unknown): string => JSON.stringify({ ok: true, data });

const failureEnvelope = JSON.stringify({ ok: false, error: { code: "sql_rejected", message: "relation is not allowed" } });

/**
 * The web route as a real local server, so every call crosses the same
 * `fetch` and defense-in-depth layer it does in the Lambda.
 */
const startBridge = async (answer: (call: ReceivedCall, index: number) => BridgeAnswer): Promise<FakeBridge> => {
  const calls: Array<ReceivedCall> = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    request.on("end", () => {
      const call: ReceivedCall = {
        authorization: request.headers.authorization,
        userAgent: request.headers["user-agent"],
        body: bridgeBodySchema.parse(JSON.parse(text)),
      };
      calls.push(call);
      const reply = answer(call, calls.length - 1);
      response.writeHead(reply.status, { "content-type": "application/json", connection: "close" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, BRIDGE_HOST, resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the bridge has no bound port");

  return {
    bridge: { url: `http://${BRIDGE_HOST}:${String(address.port)}/api/chat/sandbox/sql`, authorization: AUTHORIZATION },
    calls,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
};

const runWithBridge = async (
  command: string,
  sqlBridge: ChatSandboxSqlBridge | undefined,
): Promise<ChatSandboxBashResponse> =>
  runChatSandboxBash(
    {
      operation: "bash",
      sessionId: "0f1e2d3c-4b5a-4968-8776-65544332211f",
      command,
      files: [],
      writeSlots: [],
      ...(sqlBridge === undefined ? {} : { sqlBridge }),
    },
    Date.now() + 60_000,
  );

const withBridge = async (
  answer: (call: ReceivedCall, index: number) => BridgeAnswer,
  run: (fake: FakeBridge) => Promise<void>,
): Promise<void> => {
  const fake = await startBridge(answer);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
};

test("the shell commands send one statement and print the tool's JSON", async (): Promise<void> => {
  await withBridge(() => ({ status: 200, body: okEnvelope({ rows: [{ n: 1 }] }) }), async (fake) => {
    const response = await runWithBridge(
      "ebt-sql-query 'SELECT 1'; printf 'UPDATE t SET a = 1' > /work/batch.sql; ebt-sql-execute < /work/batch.sql",
      fake.bridge,
    );

    assert.equal(response.stderr, "");
    assert.equal(response.exitCode, 0);
    assert.equal(response.stdout, `${okEnvelope({ rows: [{ n: 1 }] })}\n${okEnvelope({ rows: [{ n: 1 }] })}\n`);
    assert.deepEqual(fake.calls, [
      {
        authorization: AUTHORIZATION,
        userAgent: SQL_BRIDGE_USER_AGENT,
        body: { kind: "query", sql: "SELECT 1", workspaceId: null },
      },
      {
        authorization: AUTHORIZATION,
        userAgent: SQL_BRIDGE_USER_AGENT,
        body: { kind: "execute", sql: "UPDATE t SET a = 1", workspaceId: null },
      },
    ]);
  });
});

test("a failure envelope reaches the shell's stderr and the script's catch, nothing else", async (): Promise<void> => {
  await withBridge(() => ({ status: 200, body: failureEnvelope }), async (fake) => {
    const shell = await runWithBridge("ebt-sql-execute 'DELETE FROM x'", fake.bridge);
    assert.equal(shell.stdout, "");
    assert.equal(shell.stderr, `${failureEnvelope}\n`);
    assert.equal(shell.exitCode, 1);

    const script = await runWithBridge(
      `js-exec -c 'try { tools.sql.query({ sql: "SELECT x" }); } catch (error) { console.log(JSON.parse(error.message).error.code); }'`,
      fake.bridge,
    );
    assert.equal(script.stderr, "");
    assert.equal(script.stdout, "sql_rejected\n");
  });
});

test("js-exec code reads results as values and prints only what it chooses", async (): Promise<void> => {
  await withBridge(
    (call) => ({ status: 200, body: okEnvelope({ echoed: call.body }) }),
    async (fake) => {
      const response = await runWithBridge(
        `js-exec -c 'let n = 0; for (let i = 0; i < 3; i += 1) { const r = tools.sql.execute({ sql: "INSERT " + i, workspaceId: "w-2" }); if (r.ok) n += 1; } console.log("inserted", n);'`,
        fake.bridge,
      );

      assert.equal(response.stderr, "");
      assert.equal(response.stdout, "inserted 3\n");
      assert.deepEqual(
        fake.calls.map((call) => call.body),
        [0, 1, 2].map((i) => ({ kind: "execute", sql: `INSERT ${String(i)}`, workspaceId: "w-2" })),
      );
    },
  );
});

test("a command stops sending once it has made the most SQL calls one command may", async (): Promise<void> => {
  await withBridge(() => ({ status: 200, body: okEnvelope({}) }), async (fake) => {
    const response = await runWithBridge(
      `js-exec -c 'let sent = 0; try { for (;;) { tools.sql.query({ sql: "SELECT 1" }); sent += 1; } } catch (error) { console.log(sent, error.message); }'`,
      fake.bridge,
    );

    assert.equal(fake.calls.length, SANDBOX_MAX_SQL_CALLS_PER_COMMAND);
    assert.match(response.stdout, new RegExp(`^${String(SANDBOX_MAX_SQL_CALLS_PER_COMMAND)} This bash command already made`));
  });
});

test("without a bridge in the request, both surfaces say SQL from code is unavailable", async (): Promise<void> => {
  const response = await runWithBridge(
    `js-exec -c 'try { tools.sql.query({ sql: "SELECT 1" }); } catch (error) { console.log(error.message); }'; ebt-sql-query 'SELECT 1'; echo "exit=$?"`,
    undefined,
  );

  const message = "SQL from code is unavailable in this command: run the statement with the sql_query or sql_execute tool instead.";
  assert.equal(response.stdout, `${message}\nexit=1\n`);
  assert.equal(response.stderr, `${message}\n`);
});

test("a read is retried after a gateway failure, a write is not and says it may have landed", async (): Promise<void> => {
  await withBridge(
    (call, index) => (index === 0 || call.body.kind === "execute"
      ? { status: 503, body: "<html>edge page for app.example</html>" }
      : { status: 200, body: okEnvelope({}) }),
    async (fake) => {
      const read = await runWithBridge("ebt-sql-query 'SELECT 1'", fake.bridge);
      assert.equal(read.exitCode, 0);
      assert.equal(fake.calls.length, 2);

      const write = await runWithBridge("ebt-sql-execute 'DELETE FROM x'", fake.bridge);
      assert.equal(fake.calls.length, 3);
      assert.equal(write.exitCode, 1);
      assert.equal(
        write.stderr,
        "The SQL bridge did not confirm this write (HTTP 503), so it may have been applied: read back with a SELECT before sending it again.\n",
      );
    },
  );
});

test("a write is retried when the call was refused before it ran", async (): Promise<void> => {
  await withBridge(
    (_call, index) => (index === 0 ? { status: 429, body: "{}" } : { status: 200, body: okEnvelope({}) }),
    async (fake) => {
      const response = await runWithBridge("ebt-sql-execute 'DELETE FROM x'", fake.bridge);

      assert.equal(response.exitCode, 0);
      assert.equal(fake.calls.length, 2);
    },
  );
});

test("a write that never left is retried, and the failure names neither host nor capability", async (): Promise<void> => {
  // Bound and closed, so the port is known to refuse the connection.
  const closed = await startBridge(() => ({ status: 200, body: okEnvelope({}) }));
  await closed.close();

  const response = await runWithBridge("ebt-sql-execute 'DELETE FROM x'", closed.bridge);

  assert.equal(response.exitCode, 1);
  assert.equal(
    response.stderr,
    "The SQL bridge did not complete this execute call: errorName=TypeError errorCode=ECONNREFUSED\n",
  );
  assert.doesNotMatch(response.stderr, new RegExp(`${BRIDGE_HOST}|${AUTHORIZATION}`));
});
