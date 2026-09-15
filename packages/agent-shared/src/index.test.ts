import assert from "node:assert/strict";
import test from "node:test";
import { getAgentSchemaHints } from "./index.js";
import { getAllowedRelationNames } from "./sql-policy.js";

// These hints are the only per-relation documentation agents receive, so a
// relation the SQL policy allows must never reach one undocumented.
test("every allowed relation has hints with a summary and resolvable related names", (): void => {
  const allowedNames = getAllowedRelationNames();

  for (const name of allowedNames) {
    const hints = getAgentSchemaHints(name);
    assert.ok(hints, `Missing agent schema hints for ${name}`);
    assert.ok(hints.summary.length > 0, `Empty summary for ${name}`);
    for (const relatedName of hints.related) {
      assert.ok(
        allowedNames.includes(relatedName),
        `Related relation ${relatedName} of ${name} is not an allowed relation`,
      );
    }
  }
});
