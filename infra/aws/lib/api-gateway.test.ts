import assert from "node:assert/strict";
import test from "node:test";
import {
  createMissingApiKeyResponseBody,
  createRejectedApiKeyResponseBody,
} from "./api-gateway";

/**
 * API Gateway renders both credential-refusal bodies as Velocity templates:
 * an undefined `$reference` is stripped silently, `#` starts a directive, and
 * a backslash escape is rendered verbatim. Any of them truncates or corrupts
 * a live refusal while the TypeScript source still looks correct, so this
 * guards the rendered bodies rather than any single contributing constant.
 */
const VELOCITY_SPECIAL_CHARACTERS: ReadonlyArray<string> = ["$", "#", "\\"];

type CredentialRefusalBody = Readonly<{
  name: string;
  body: string;
}>;

const CREDENTIAL_REFUSAL_BODIES: ReadonlyArray<CredentialRefusalBody> = [
  { name: "missing_api_key", body: createMissingApiKeyResponseBody() },
  {
    name: "api_key_not_accepted",
    body: createRejectedApiKeyResponseBody("https://api.example.com/v1"),
  },
];

test("gateway credential refusals carry no Velocity-special character", (): void => {
  for (const refusal of CREDENTIAL_REFUSAL_BODIES) {
    for (const character of VELOCITY_SPECIAL_CHARACTERS) {
      assert.equal(
        refusal.body.includes(character),
        false,
        `${refusal.name} body must not contain ${character}, which Velocity would eat: ${refusal.body}`,
      );
    }
  }
});

// Literal expectations on purpose: these are the two strings a refused caller
// needs, so asserting against the shared constants would be tautological.
test("gateway credential refusals still name the header and the key variable", (): void => {
  for (const refusal of CREDENTIAL_REFUSAL_BODIES) {
    assert.ok(
      refusal.body.includes("Authorization: ApiKey"),
      `${refusal.name} body must name the header: ${refusal.body}`,
    );
    assert.ok(
      refusal.body.includes("EXPENSE_BUDGET_TRACKER_API_KEY"),
      `${refusal.name} body must name the key environment variable: ${refusal.body}`,
    );
  }
});
