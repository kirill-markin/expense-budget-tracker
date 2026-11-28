import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getWorkspaceBootstrapRouteWithDeps } from "./workspaces/bootstrap/route";

const createRequest = (returnTo: string): Request =>
  new Request(`http://localhost/api/workspaces/bootstrap?returnTo=${encodeURIComponent(returnTo)}`, {
    method: "GET",
    headers: {
      "x-user-id": "user-1",
      "x-user-email": "user@example.com",
      "x-user-email-verified": "true",
      "x-workspace-id": "workspace-1",
      cookie: "locale=ar; locale=he; auth_locale=fa",
      "accept-language": "es",
    },
  });

test("getWorkspaceBootstrapRouteWithDeps sets workspace cookie and redirects to requested path", async (): Promise<void> => {
  const response = await getWorkspaceBootstrapRouteWithDeps(
    createRequest("/balances?month=2026-04&locale=ZH-hans"),
    {
      resolveWorkspaceForIdentity: async (_identity, requestedWorkspaceId, initialLocale) => {
        assert.equal(requestedWorkspaceId, "workspace-1");
        assert.equal(initialLocale, "zh");
        return {
          workspaceId: "workspace-1",
          name: "Main",
          created: false,
          requestedWorkspaceAccessible: true,
        };
      },
      getUserSettings: async (_userId, _workspaceId, initialLocale) => {
        assert.equal(initialLocale, "zh");
        return { ...DEFAULT_USER_SETTINGS, locale: "ru" };
      },
    },
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/balances?month=2026-04&locale=ZH-hans");
  const setCookies = response.headers.getSetCookie().join("\n");
  assert.match(setCookies, /workspace=workspace-1/);
  assert.match(setCookies, /app_locale=ru/);
});

test("getWorkspaceBootstrapRouteWithDeps falls back to root for invalid returnTo", async (): Promise<void> => {
  const response = await getWorkspaceBootstrapRouteWithDeps(
    createRequest("https://evil.example.com"),
    {
      resolveWorkspaceForIdentity: async () => ({
        workspaceId: "workspace-1",
        name: "Main",
        created: false,
        requestedWorkspaceAccessible: false,
      }),
      getUserSettings: async (_userId, _workspaceId, initialLocale) => {
        assert.equal(initialLocale, "es");
        return { ...DEFAULT_USER_SETTINGS, locale: initialLocale };
      },
    },
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/");
  assert.match(response.headers.getSetCookie().join("\n"), /app_locale=es/);
});
