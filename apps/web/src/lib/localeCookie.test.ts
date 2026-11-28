import assert from "node:assert/strict";
import test from "node:test";

import { getDemoLocalePreference, getLocaleFromRequest } from "./localeCookie";

test("Demo language preference resolves independently of the Settings preview", (): void => {
  const cases = [
    { cookies: "; locale=he; app_locale=ru; demo_locale=en", language: "uk", expected: "en" },
    { cookies: "; locale=fa; locale=he; app_locale=ru", language: "uk", expected: "he" },
    { cookies: "; app_locale=ru", language: "uk", expected: "ru" },
    { cookies: "", language: "uk", expected: "uk" },
    { cookies: "", language: "de", expected: "en" },
  ];

  for (const { cookies, language, expected } of cases) {
    const headers = new Headers({
      cookie: `demo=true${cookies}`,
      "accept-language": language,
      "x-request-path": "/settings?locale=es",
    });
    assert.equal(getLocaleFromRequest(new Request("https://app.example.com/settings?locale=es", { headers })), "es");
    assert.equal(getDemoLocalePreference(headers), expected);
    assert.equal(getLocaleFromRequest(new Request("https://app.example.com/settings", { headers })), expected);
  }
});
