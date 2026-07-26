import assert from "node:assert/strict";
import test from "node:test";

import { getSessionCatalogRouteWithDeps } from "@/server/chat/http/sessionCatalogRoute";
import {
  encodeChatSessionCatalogCursor,
  type ChatSessionCatalogPage,
} from "@/server/chat/store/sessionCatalogStore";
import {
  ACTIVE_WORKSPACE_RELOAD_MESSAGE,
  WorkspaceAccessError,
} from "@/server/workspaceErrors";

const catalogPage: ChatSessionCatalogPage = {
  sessions: [{
    sessionId: "session-1",
    title: "Balance check",
    lastMessageAt: "2026-07-26T16:42:00.000Z",
    status: "running",
    mainContentInvalidationVersion: 8,
  }],
  nextCursor: null,
};

const createHeaders = (): Headers =>
  new Headers({
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
    cookie: "demo=true",
  });

const encodeUncheckedCursor = (cursor: unknown): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

test("session catalog route returns the authenticated workspace page without caching", async (): Promise<void> => {
  const response = await getSessionCatalogRouteWithDeps(
    new Request("http://localhost/api/chat/sessions", {
      headers: createHeaders(),
    }),
    {
      listChatSessions: async (userId, workspaceId, limit, cursor) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        assert.equal(limit, 30);
        assert.equal(cursor, null);
        return catalogPage;
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), catalogPage);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate",
  );
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
});

test("session catalog route decodes a cursor and forwards an explicit limit", async (): Promise<void> => {
  const cursor = {
    lastMessageAt: "2026-07-26T16:42:00.000123Z",
    sessionId: "session-1",
  } as const;
  const encodedCursor = encodeChatSessionCatalogCursor(cursor);
  const response = await getSessionCatalogRouteWithDeps(
    new Request(
      `http://localhost/api/chat/sessions?limit=12&cursor=${encodedCursor}`,
      { headers: createHeaders() },
    ),
    {
      listChatSessions: async (_userId, _workspaceId, limit, receivedCursor) => {
        assert.equal(limit, 12);
        assert.deepEqual(receivedCursor, cursor);
        return { sessions: [], nextCursor: null };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessions: [], nextCursor: null });
});

test("session catalog route rejects invalid limits without reading the store", async (): Promise<void> => {
  const invalidLimits = ["0", "101", "1.5", "03"] as const;

  for (const invalidLimit of invalidLimits) {
    let storeCalled = false;
    const response = await getSessionCatalogRouteWithDeps(
      new Request(
        `http://localhost/api/chat/sessions?limit=${invalidLimit}`,
        { headers: createHeaders() },
      ),
      {
        listChatSessions: async () => {
          storeCalled = true;
          return catalogPage;
        },
      },
    );

    assert.equal(response.status, 400);
    assert.equal(
      await response.text(),
      "limit must be an integer between 1 and 100",
    );
    assert.equal(storeCalled, false);
  }
});

test("session catalog route rejects an invalid cursor without restarting pagination", async (): Promise<void> => {
  let storeCalled = false;
  const response = await getSessionCatalogRouteWithDeps(
    new Request("http://localhost/api/chat/sessions?cursor=invalid%2Bcursor", {
      headers: createHeaders(),
    }),
    {
      listChatSessions: async () => {
        storeCalled = true;
        return catalogPage;
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    "Invalid chat session cursor: expected a non-empty base64url value",
  );
  assert.equal(storeCalled, false);
});

test("session catalog route rejects year-zero cursor timestamps before querying", async (): Promise<void> => {
  let storeCalled = false;
  const cursor = encodeUncheckedCursor({
    lastMessageAt: "0000-01-01T00:00:00.000000Z",
    sessionId: "session-1",
  });
  const response = await getSessionCatalogRouteWithDeps(
    new Request(
      `http://localhost/api/chat/sessions?cursor=${cursor}`,
      { headers: createHeaders() },
    ),
    {
      listChatSessions: async () => {
        storeCalled = true;
        return catalogPage;
      },
    },
  );

  assert.equal(response.status, 400);
  assert.match(
    await response.text(),
    /Invalid chat session cursor: lastMessageAt: lastMessageAt must be a canonical UTC timestamp with six fractional digits/,
  );
  assert.equal(storeCalled, false);
});

test("session catalog route rejects cursor payloads with malformed UTF-8", async (): Promise<void> => {
  let storeCalled = false;
  const cursorPrefix = Buffer.from(
    '{"lastMessageAt":"2026-07-26T16:42:00.000123Z","sessionId":"',
    "utf8",
  );
  const cursorSuffix = Buffer.from('"}', "utf8");
  const cursor = Buffer.concat([
    cursorPrefix,
    Buffer.from([0xff]),
    cursorSuffix,
  ]).toString("base64url");
  const response = await getSessionCatalogRouteWithDeps(
    new Request(
      `http://localhost/api/chat/sessions?cursor=${cursor}`,
      { headers: createHeaders() },
    ),
    {
      listChatSessions: async () => {
        storeCalled = true;
        return catalogPage;
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    "Invalid chat session cursor: value could not be decoded",
  );
  assert.equal(storeCalled, false);
});

test("session catalog route rejects non-well-formed Unicode cursor session ids", async (): Promise<void> => {
  let storeCalled = false;
  const cursor = encodeUncheckedCursor({
    lastMessageAt: "2026-07-26T16:42:00.000123Z",
    sessionId: "session-\uD800",
  });
  const response = await getSessionCatalogRouteWithDeps(
    new Request(
      `http://localhost/api/chat/sessions?cursor=${cursor}`,
      { headers: createHeaders() },
    ),
    {
      listChatSessions: async () => {
        storeCalled = true;
        return catalogPage;
      },
    },
  );

  assert.equal(response.status, 400);
  assert.match(
    await response.text(),
    /Invalid chat session cursor: sessionId: sessionId must be well-formed Unicode/,
  );
  assert.equal(storeCalled, false);
});

test("session catalog route returns 400 for cursor session ids with control characters", async (): Promise<void> => {
  const invalidSessionIds = [
    "session\u0000id",
    "session\nid",
  ] as const;

  for (const sessionId of invalidSessionIds) {
    let storeCalled = false;
    const cursor = encodeUncheckedCursor({
      lastMessageAt: "2026-07-26T16:42:00.000123Z",
      sessionId,
    });
    const response = await getSessionCatalogRouteWithDeps(
      new Request(
        `http://localhost/api/chat/sessions?cursor=${cursor}`,
        { headers: createHeaders() },
      ),
      {
        listChatSessions: async () => {
          storeCalled = true;
          return catalogPage;
        },
      },
    );

    assert.equal(response.status, 400);
    assert.match(
      await response.text(),
      /Invalid chat session cursor: sessionId: sessionId must not contain control characters/,
    );
    assert.equal(storeCalled, false);
  }
});

test("session catalog route returns 401 when trusted identity headers are missing", async (): Promise<void> => {
  const requests = [
    new Request("http://localhost/api/chat/sessions", {
      headers: { "x-workspace-id": "workspace-1" },
    }),
    new Request("http://localhost/api/chat/sessions", {
      headers: { "x-user-id": "user-1" },
    }),
  ] as const;

  for (const request of requests) {
    const response = await getSessionCatalogRouteWithDeps(request, {
      listChatSessions: async () => catalogPage,
    });

    assert.equal(response.status, 401);
    assert.match(await response.text(), /proxy misconfiguration/);
  }
});

test("session catalog route maps inaccessible workspace context to 409", async (): Promise<void> => {
  const response = await getSessionCatalogRouteWithDeps(
    new Request("http://localhost/api/chat/sessions", {
      headers: createHeaders(),
    }),
    {
      listChatSessions: async (userId, workspaceId) => {
        throw new WorkspaceAccessError(userId, workspaceId);
      },
    },
  );

  assert.equal(response.status, 409);
  assert.equal(await response.text(), ACTIVE_WORKSPACE_RELOAD_MESSAGE);
});
