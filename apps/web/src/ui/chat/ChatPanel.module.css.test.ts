import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("reasoningSummary keeps the default panel background", () => {
  const styles = readFileSync(new URL("./ChatPanel.module.css", import.meta.url), "utf8");
  const match = styles.match(/\.reasoningSummary\s*\{([^}]*)\}/);

  assert.notEqual(match, null);
  assert.equal(match?.[1]?.includes("background:"), false);
});
