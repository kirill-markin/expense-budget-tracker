import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentErrorPayload,
  buildAgentSuccessPayload,
  getAmbiguousMutationInstructions,
  getDeadlineInstructions,
  getSqlPolicyInstructions,
  getUnexpectedErrorInstructions,
  serializeAgentPayload,
} from "./agentResults.js";
import { SqlPolicyError } from "./sql-policy.js";

const DEFAULT_SQL_REMEDY = /Fix the SQL using the policy error message/u;

// Codes a caller clears by reshaping the request rather than by editing the
// statement text. The default remedy would send them back into the same failure.
const REQUEST_SHAPE_POLICY_CODES = [
  "single_statement_required",
  "sql_script_too_long",
  "too_many_sql_statements",
  "sql_result_too_large",
  "mutation_statement_row_limit_exceeded",
  "mutation_request_row_limit_exceeded",
] as const;

test("agent success payloads serialize compactly without indentation", (): void => {
  const text = serializeAgentPayload(buildAgentSuccessPayload(
    { workspaces: [{ workspaceId: "w-1", name: "Personal" }] },
    "Choose one returned workspaceId.",
  ));

  assert.equal(text.includes("\n"), false);
  assert.equal(text.includes("  "), false);
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    data: { workspaces: [{ workspaceId: "w-1", name: "Personal" }] },
    instructions: "Choose one returned workspaceId.",
  });
});

test("agent error payloads carry details only when there are details to carry", (): void => {
  assert.deepEqual(buildAgentErrorPayload("internal_error", "Failed", "Retry once.", {}), {
    ok: false,
    error: { code: "internal_error", message: "Failed" },
    instructions: "Retry once.",
  });
  assert.deepEqual(
    buildAgentErrorPayload("request_deadline_exceeded", "Too slow", "Retry.", { retryable: true }),
    {
      ok: false,
      error: {
        code: "request_deadline_exceeded",
        message: "Too slow",
        details: { retryable: true },
      },
      instructions: "Retry.",
    },
  );
});

test("a rejected multi-statement script is told to split into one call per statement", (): void => {
  const instructions = getSqlPolicyInstructions(
    new SqlPolicyError("single_statement_required", "This SQL endpoint accepts exactly one statement"),
    "sql_execute",
  );

  assert.match(instructions, /one statement per call/u);
  assert.match(instructions, /sql_execute/u);
  assert.doesNotMatch(instructions, DEFAULT_SQL_REMEDY);
});

test("policy codes fixed by reshaping the request never fall through to the default SQL remedy", (): void => {
  for (const code of REQUEST_SHAPE_POLICY_CODES) {
    const instructions = getSqlPolicyInstructions(
      new SqlPolicyError(code, "policy limit exceeded"),
      "sql_query",
    );

    assert.doesNotMatch(instructions, DEFAULT_SQL_REMEDY);
  }
});

test("policy codes fixed by editing the statement text keep the default SQL remedy", (): void => {
  const instructions = getSqlPolicyInstructions(
    new SqlPolicyError("sql_comments_not_allowed", "SQL comments are not allowed"),
    "sql_query",
  );

  assert.match(instructions, DEFAULT_SQL_REMEDY);
  assert.match(instructions, /sql_query/u);
});

test("blocked relations send the caller to the schema before retrying", (): void => {
  const instructions = getSqlPolicyInstructions(
    new SqlPolicyError("relation_not_allowed", "Relation secrets is not allowed"),
    "sql_query",
  );

  assert.match(instructions, /get_schema/u);
});

test("a bare sql_execute deadline is explicitly safe to retry", (): void => {
  const instructions = getDeadlineInstructions("sql_execute");

  assert.match(instructions, /Retry sql_execute/u);
  assert.match(instructions, /before the mutation was dispatched/u);
  assert.doesNotMatch(instructions, /verify whether it applied/u);
});

test("read deadlines state why retrying cannot duplicate a mutation", (): void => {
  assert.match(getDeadlineInstructions("sql_query"), /safe to retry/u);
});

test("ambiguous mutation outcomes must be verified before any retry", (): void => {
  const instructions = getAmbiguousMutationInstructions();

  assert.match(instructions, /Do not blindly retry/u);
  assert.match(instructions, /Use sql_query to verify/u);
});

test("unexpected failures get one retry and then a stop", (): void => {
  assert.match(getUnexpectedErrorInstructions("get_schema"), /Retry get_schema once/u);
});
