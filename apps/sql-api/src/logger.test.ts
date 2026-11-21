import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import pg from "pg";
import { DatabaseSecretTimeoutError } from "./config.js";
import { getSafeErrorType } from "./logger.js";

const CONNECTION_TIMEOUT_MS = 50;

// A TCP server that accepts connections and never answers, so every pg
// connection attempt against it ends in the library's own timeout error.
const startSilentServer = async (): Promise<Readonly<{ port: number; close: () => Promise<void> }>> => {
  const sockets: Array<Socket> = [];
  const server = createServer((socket: Socket): void => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async (): Promise<void> => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const getRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the database connection attempt to reject");
};

test("getSafeErrorType names the database secret and connection timeouts", async () => {
  const server = await startSilentServer();
  const connection = { host: "127.0.0.1", port: server.port, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS };
  const pool = new pg.Pool({ ...connection, max: 1 });
  const client = new pg.Client(connection);
  try {
    // With max: 1 the first connect opens the only client and the second waits
    // for it, so the two attempts hit the pool's two different timeouts.
    const [newClientTimeout, acquireTimeout, clientTimeout] = await Promise.all([
      getRejection(pool.connect()),
      getRejection(pool.connect()),
      getRejection(client.connect()),
    ]);

    assert.equal(getSafeErrorType(newClientTimeout), "database_connection_timeout");
    assert.equal(getSafeErrorType(acquireTimeout), "database_connection_timeout");
    assert.equal(getSafeErrorType(clientTimeout), "database_connection_timeout");
  } finally {
    await pool.end();
    await server.close();
  }

  assert.equal(
    getSafeErrorType(new DatabaseSecretTimeoutError("arn:aws:secretsmanager:test", 5_000, new Error("aborted"))),
    "database_secret_timeout",
  );
  assert.equal(getSafeErrorType(new Error("relation does not exist")), "error");
});
