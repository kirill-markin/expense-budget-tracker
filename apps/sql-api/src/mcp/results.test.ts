import assert from "node:assert/strict";
import test from "node:test";
import type { SqlApiLogEvent } from "../logger.js";
import { UserSqlExecutionError } from "../machineApi/sqlService.js";
import { buildMcpToolErrorResultWithDependencies } from "./results.js";

type JsonObject = Readonly<Record<string, unknown>>;

const parsePayload = (text: string): JsonObject => {
  const value: unknown = JSON.parse(text);
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonObject;
};

const readResultPayload = (
  result: ReturnType<typeof buildMcpToolErrorResultWithDependencies>,
): JsonObject => {
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type !== "text") {
    throw new Error("Expected MCP text content");
  }
  return parsePayload(content.text);
};

test("MCP error results preserve actionable user SQL errors", (): void => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const sqlError = new UserSqlExecutionError("column amountt does not exist");
  const payload = readResultPayload(buildMcpToolErrorResultWithDependencies(
    sqlError,
    "sql_query",
    { log: (event) => logEvents.push(event) },
  ));

  const error = payload["error"] as JsonObject;
  assert.equal(error["code"], "sql_execution_failed");
  assert.equal(error["message"], "column amountt does not exist");
  assert.deepEqual(logEvents, []);
});

test("MCP error results sanitize untagged PostgreSQL failures", (): void => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const databaseError = Object.assign(
    new Error("column internal_secret does not exist on db.internal.example"),
    { code: "42703" },
  );
  const payload = readResultPayload(buildMcpToolErrorResultWithDependencies(
    databaseError,
    "sql_query",
    { log: (event) => logEvents.push(event) },
  ));
  const serialized = JSON.stringify(payload);
  const error = payload["error"] as JsonObject;

  assert.equal(error["code"], "internal_error");
  assert.equal(serialized.includes("internal_secret"), false);
  assert.equal(serialized.includes("db.internal.example"), false);
  assert.deepEqual(logEvents, [{
    domain: "sql_api",
    action: "mcp_unexpected_error",
    boundary: "tool",
    operation: "sql_query",
    errorType: "error",
  }]);
});

test("MCP error results sanitize and structurally log unexpected failures", (): void => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const payload = readResultPayload(buildMcpToolErrorResultWithDependencies(
    new Error("connection to db.internal.example failed with password secret"),
    "get_schema",
    { log: (event) => logEvents.push(event) },
  ));
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes("db.internal.example"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.deepEqual(logEvents, [{
    domain: "sql_api",
    action: "mcp_unexpected_error",
    boundary: "tool",
    operation: "get_schema",
    errorType: "error",
  }]);
});

test("unexpected sql_execute errors warn against blind mutation retries", (): void => {
  const databaseError = Object.assign(
    new Error("duplicate key value exposes internal_constraint"),
    { code: "23505" },
  );
  const payload = readResultPayload(buildMcpToolErrorResultWithDependencies(
    databaseError,
    "sql_execute",
    { log: () => undefined },
  ));
  const instructions = payload["instructions"];
  const serialized = JSON.stringify(payload);
  const error = payload["error"] as JsonObject;

  assert.equal(error["code"], "internal_error");
  assert.equal(serialized.includes("internal_constraint"), false);
  assert.equal(typeof instructions, "string");
  assert.match(instructions as string, /Do not blindly retry/u);
  assert.match(instructions as string, /Use sql_query to verify/u);
});
