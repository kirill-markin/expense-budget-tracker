import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("mainContentWithChatClearance adds bottom clearance with a logical property", () => {
  const styles = readFileSync(new URL("./ChatLayoutShell.module.css", import.meta.url), "utf8");
  const match = styles.match(/\.mainContentWithChatClearance\s*\{([^}]*)\}/);

  assert.notEqual(match, null);
  if (match === null) {
    throw new Error("Expected .mainContentWithChatClearance rule to exist");
  }

  assert.match(match[1], /padding-block-end:\s*calc\(var\(--chat-toggle-clearance\)\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/);
});
