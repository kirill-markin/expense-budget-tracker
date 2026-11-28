import assert from "node:assert/strict";
import test from "node:test";

import { withDemoLocaleHint } from "./localeHint";

test("a validated Demo locale travels between app routes with destination query and hash", (): void => {
  const preview = new URLSearchParams("locale=he&budgetView=year");
  assert.equal(withDemoLocaleHint("/", preview), "/?locale=he");
  assert.equal(withDemoLocaleHint("/transactions", preview), "/transactions?locale=he");
  assert.equal(
    withDemoLocaleHint("/chat?session=existing&view=one&view=two#history", preview),
    "/chat?session=existing&view=one&view=two&locale=he#history",
  );
});

test("invalid previews and links outside the ordinary Demo app routes are unchanged", (): void => {
  const preview = new URLSearchParams("locale=he");
  assert.equal(withDemoLocaleHint("/settings", null), "/settings");
  assert.equal(withDemoLocaleHint("/budget", new URLSearchParams("locale=invalid")), "/budget");
  for (const href of ["/share/monthly/report", "/api/user-settings", "//other.example/chat", "https://other.example/chat"]) {
    assert.equal(withDemoLocaleHint(href, preview), href);
  }
});
