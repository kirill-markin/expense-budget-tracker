import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_USER_SETTINGS, type UserSettings } from "@/lib/locale";

const endpoint = "https://app.example.com/api/user-settings";

test("account settings repopulate the app locale independently of the login hint", async (t): Promise<void> => {
  t.mock.module("@/server/userSettings", {
    exports: {
      getUserSettings: async (): Promise<UserSettings> => ({ ...DEFAULT_USER_SETTINGS, locale: "ru" }),
      updateUserSettings: async (): Promise<UserSettings> => {
        throw new Error("Expected no settings update");
      },
    },
  });
  const { GET } = await import("./route");
  const headers = { "x-user-id": "user-1", "x-workspace-id": "workspace-1", cookie: "locale=zh; app_locale=es" };
  const response = await GET(new Request(`${endpoint}?locale=ar`, { headers }));
  assert.equal((await response.json()).locale, "ru");
  assert.match(response.headers.getSetCookie().join("\n"), /app_locale=ru;/u);
});

test("demo settings use the current same-origin page hint and keep a separate deliberate choice", async (): Promise<void> => {
  const { GET, PUT } = await import("./route");
  const headers = { cookie: "demo=true; app_locale=en; locale_hint=fa", "accept-language": "es" };
  const hinted = await GET(new Request(endpoint, {
    headers: { ...headers, referer: "https://app.example.com/settings?locale=ZH-hans" },
  }));
  assert.equal((await hinted.json()).locale, "zh");

  for (const referer of [
    "https://app.example.com.other/settings?locale=zh",
    "https://app.example.com/share/monthly/token?locale=zh",
  ]) {
    const unrelated = await GET(new Request(endpoint, { headers: { ...headers, referer } }));
    assert.equal((await unrelated.json()).locale, "en");
  }

  const demoWrite = await PUT(new Request(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({ locale: "he" }),
  }));
  assert.equal((await demoWrite.json()).locale, "he");
  const [demoCookie] = demoWrite.headers.getSetCookie();
  assert.match(demoCookie, /^demo_locale=he;.*Max-Age=31536000/u);
  assert.doesNotMatch(demoCookie, /Domain=/u);

  const account = await GET(new Request(endpoint, {
    headers: { "x-user-id": "user-1", "x-workspace-id": "workspace-1", cookie: "app_locale=en; demo_locale=he" },
  }));
  assert.equal((await account.json()).locale, "ru");
  assert.match(account.headers.getSetCookie().join("\n"), /app_locale=ru;/u);

  const laterRead = await GET(new Request(endpoint, { headers: { cookie: "demo=true; app_locale=ru; demo_locale=he" } }));
  assert.equal((await laterRead.json()).locale, "he");
});

test("Demo retains the pre-upgrade language alongside the cached account language", async (): Promise<void> => {
  const { GET } = await import("./route");
  const headers = { cookie: "demo=true; locale=he; app_locale=ru", "accept-language": "en" };
  const migrated = await GET(new Request(endpoint, { headers }));
  assert.equal((await migrated.json()).locale, "he");

  const updated = await GET(new Request(endpoint, {
    headers: { ...headers, cookie: headers.cookie + "; demo_locale=es" },
  }));
  assert.equal((await updated.json()).locale, "es");
});
