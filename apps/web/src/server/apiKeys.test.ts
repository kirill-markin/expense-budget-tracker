import assert from "node:assert/strict";
import test from "node:test";
import { generateApiKey, normalizeApiKey } from "./apiKeys";

test("generateApiKey emits the shorter Crockford SQL API key format", () => {
  const key = generateApiKey();

  assert.match(key, /^ebt_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
});

test("normalizeApiKey ignores hyphens and spaces in the Crockford body", () => {
  assert.equal(
    normalizeApiKey("ebt_abcd-efgh jkmn-pqrs-tvwx-yz23-45"),
    "ebt_ABCDEFGHJKMNPQRSTVWXYZ2345",
  );
});
