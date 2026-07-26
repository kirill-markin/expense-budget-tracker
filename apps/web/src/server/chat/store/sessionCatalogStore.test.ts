import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import type { ChatSessionRunState } from "@/server/chat/store";
import {
  decodeChatSessionCatalogCursor,
  encodeChatSessionCatalogCursor,
  InvalidChatSessionCatalogCursorError,
  listChatSessionsWithQuery,
} from "@/server/chat/store/sessionCatalogStore";
import type { QueryFn } from "@/server/db/contextRunner";

const createQueryResult = (
  rows: ReadonlyArray<unknown>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createCatalogRow = (
  sessionId: string,
  title: string | null,
  lastMessageAt: string,
  status: ChatSessionRunState,
  invalidationVersion: string,
): Readonly<Record<string, unknown>> => ({
  session_id: sessionId,
  title,
  last_message_at_exact: lastMessageAt,
  status,
  main_content_invalidation_version: invalidationVersion,
});

const encodeUncheckedCursor = (cursor: unknown): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

test("chat session catalog cursor round-trips both ordering fields", (): void => {
  const cursor = {
    lastMessageAt: "2026-07-26T16:42:00.000123Z",
    sessionId: "session-😀",
  } as const;

  const encoded = encodeChatSessionCatalogCursor(cursor);

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeChatSessionCatalogCursor(encoded), cursor);
});

test("chat session catalog cursor rejects malformed and incomplete values", (): void => {
  const invalidCursors = [
    "",
    "not+base64url",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      lastMessageAt: "2026-07-26",
      sessionId: "session-2",
    }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      lastMessageAt: "2026-07-26T16:42:00.000Z",
      sessionId: "session-2",
    }), "utf8").toString("base64url"),
  ] as const;

  for (const cursor of invalidCursors) {
    assert.throws(
      () => decodeChatSessionCatalogCursor(cursor),
      InvalidChatSessionCatalogCursorError,
    );
  }
});

test("chat session catalog cursor rejects non-well-formed Unicode session ids", (): void => {
  const invalidSessionIds = [
    "session-\uD800",
    "session-\uDC00",
  ] as const;

  for (const sessionId of invalidSessionIds) {
    const cursor = encodeUncheckedCursor({
      lastMessageAt: "2026-07-26T16:42:00.000123Z",
      sessionId,
    });

    assert.throws(
      () => decodeChatSessionCatalogCursor(cursor),
      (error: unknown): boolean =>
        error instanceof InvalidChatSessionCatalogCursorError
        && error.message.includes("sessionId must be well-formed Unicode"),
    );
  }
});

test("chat session catalog cursor rejects control characters in session ids", (): void => {
  const invalidSessionIds = [
    "session\u0000id",
    "session\tid",
    "session\u007Fid",
  ] as const;

  for (const sessionId of invalidSessionIds) {
    const cursor = encodeUncheckedCursor({
      lastMessageAt: "2026-07-26T16:42:00.000123Z",
      sessionId,
    });

    assert.throws(
      () => decodeChatSessionCatalogCursor(cursor),
      (error: unknown): boolean =>
        error instanceof InvalidChatSessionCatalogCursorError
        && error.message.includes("sessionId must not contain control characters"),
    );
  }
});

test("listChatSessionsWithQuery returns the first page with stable ordering and a next cursor", async (): Promise<void> => {
  let queryText = "";
  let queryParams: ReadonlyArray<unknown> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryText = text;
    queryParams = params;
    return createQueryResult([
      createCatalogRow(
        "session-z",
        "Most recent",
        "2026-07-26T16:42:00.000123Z",
        "running",
        "8",
      ),
      createCatalogRow(
        "session-y",
        null,
        "2026-07-26T16:42:00.000123Z",
        "interrupted",
        "7",
      ),
      createCatalogRow(
        "session-x",
        "Older",
        "2026-07-26T15:00:00.000000Z",
        "idle",
        "6",
      ),
    ]);
  };

  const page = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    2,
    null,
  );

  assert.match(queryText, /WHERE user_id = \$1/);
  assert.match(queryText, /AND workspace_id = \$2/);
  assert.match(queryText, /AND last_message_at IS NOT NULL/);
  assert.match(
    queryText,
    /ORDER BY last_message_at DESC, session_id DESC/,
  );
  assert.deepEqual(queryParams, ["user-1", "workspace-1", 3]);
  assert.deepEqual(page.sessions, [
    {
      sessionId: "session-z",
      title: "Most recent",
      lastMessageAt: "2026-07-26T16:42:00.000Z",
      status: "running",
      mainContentInvalidationVersion: 8,
    },
    {
      sessionId: "session-y",
      title: "Untitled chat",
      lastMessageAt: "2026-07-26T16:42:00.000Z",
      status: "interrupted",
      mainContentInvalidationVersion: 7,
    },
  ]);
  assert.deepEqual(
    Object.keys(page.sessions[0] ?? {}).sort(),
    [
      "lastMessageAt",
      "mainContentInvalidationVersion",
      "sessionId",
      "status",
      "title",
    ],
  );
  assert.ok(page.nextCursor !== null);
  assert.deepEqual(
    decodeChatSessionCatalogCursor(page.nextCursor),
    {
      lastMessageAt: "2026-07-26T16:42:00.000123Z",
      sessionId: "session-y",
    },
  );
});

test("listChatSessionsWithQuery applies the tuple cursor on a middle page", async (): Promise<void> => {
  let queryText = "";
  let queryParams: ReadonlyArray<unknown> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryText = text;
    queryParams = params;
    return createQueryResult([
      createCatalogRow(
        "session-x",
        "Middle",
        "2026-07-26T15:00:00.000456Z",
        "idle",
        "3",
      ),
      createCatalogRow(
        "session-w",
        "Next",
        "2026-07-26T14:00:00.000000Z",
        "idle",
        "2",
      ),
    ]);
  };

  const page = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    1,
    {
      lastMessageAt: "2026-07-26T16:42:00.000123Z",
      sessionId: "session-y",
    },
  );

  assert.match(
    queryText,
    /AND \(last_message_at, session_id\) < \(\$3::timestamptz, \$4\)/,
  );
  assert.match(
    queryText,
    /ORDER BY last_message_at DESC, session_id DESC/,
  );
  assert.deepEqual(queryParams, [
    "user-1",
    "workspace-1",
    "2026-07-26T16:42:00.000123Z",
    "session-y",
    2,
  ]);
  assert.deepEqual(page.sessions.map((session) => session.sessionId), [
    "session-x",
  ]);
  assert.ok(page.nextCursor !== null);
  assert.deepEqual(decodeChatSessionCatalogCursor(page.nextCursor), {
    lastMessageAt: "2026-07-26T15:00:00.000456Z",
    sessionId: "session-x",
  });
});

test("listChatSessionsWithQuery preserves microseconds across pagination boundaries", async (): Promise<void> => {
  const queryCalls: Array<Readonly<{
    text: string;
    params: ReadonlyArray<unknown>;
  }>> = [];
  const queryPages: ReadonlyArray<ReadonlyArray<unknown>> = [
    [
      createCatalogRow(
        "session-z",
        "First",
        "2026-07-26T16:42:00.123999Z",
        "idle",
        "5",
      ),
      createCatalogRow(
        "session-y",
        "Second",
        "2026-07-26T16:42:00.123999Z",
        "idle",
        "4",
      ),
      createCatalogRow(
        "session-x",
        "Third",
        "2026-07-26T16:42:00.123750Z",
        "idle",
        "3",
      ),
    ],
    [
      createCatalogRow(
        "session-x",
        "Third",
        "2026-07-26T16:42:00.123750Z",
        "idle",
        "3",
      ),
      createCatalogRow(
        "session-w",
        "Fourth",
        "2026-07-26T16:42:00.123001Z",
        "idle",
        "2",
      ),
      createCatalogRow(
        "session-v",
        "Fifth",
        "2026-07-26T16:42:00.122999Z",
        "idle",
        "1",
      ),
    ],
    [
      createCatalogRow(
        "session-v",
        "Fifth",
        "2026-07-26T16:42:00.122999Z",
        "idle",
        "1",
      ),
    ],
  ];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryCalls.push({ text, params });
    const rows = queryPages[queryCalls.length - 1];
    if (rows === undefined) {
      throw new Error(`Unexpected catalog query call ${queryCalls.length}`);
    }
    return createQueryResult(rows);
  };

  const firstPage = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    2,
    null,
  );
  assert.ok(firstPage.nextCursor !== null);
  const secondPage = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    2,
    decodeChatSessionCatalogCursor(firstPage.nextCursor),
  );
  assert.ok(secondPage.nextCursor !== null);
  const terminalPage = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    2,
    decodeChatSessionCatalogCursor(secondPage.nextCursor),
  );

  const sessionIds = [
    ...firstPage.sessions,
    ...secondPage.sessions,
    ...terminalPage.sessions,
  ].map((session) => session.sessionId);
  assert.deepEqual(sessionIds, [
    "session-z",
    "session-y",
    "session-x",
    "session-w",
    "session-v",
  ]);
  assert.equal(new Set(sessionIds).size, sessionIds.length);
  assert.deepEqual(queryCalls[1]?.params, [
    "user-1",
    "workspace-1",
    "2026-07-26T16:42:00.123999Z",
    "session-y",
    3,
  ]);
  assert.deepEqual(queryCalls[2]?.params, [
    "user-1",
    "workspace-1",
    "2026-07-26T16:42:00.123001Z",
    "session-w",
    3,
  ]);
  assert.deepEqual(
    firstPage.sessions.map((session) => session.lastMessageAt),
    [
      "2026-07-26T16:42:00.123Z",
      "2026-07-26T16:42:00.123Z",
    ],
  );
});

test("listChatSessionsWithQuery returns a terminal page without a cursor", async (): Promise<void> => {
  const queryFn: QueryFn = async (): Promise<QueryResult> =>
    createQueryResult([
      createCatalogRow(
        "session-w",
        "Last",
        "2026-07-26T14:00:00.000000Z",
        "idle",
        "1",
      ),
    ]);

  const page = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    2,
    {
      lastMessageAt: "2026-07-26T15:00:00.000456Z",
      sessionId: "session-x",
    },
  );

  assert.deepEqual(page.sessions.map((session) => session.sessionId), [
    "session-w",
  ]);
  assert.equal(page.nextCursor, null);
});

test("listChatSessionsWithQuery accepts titles up to 200 Unicode code points", async (): Promise<void> => {
  const title = "😀".repeat(200);
  const queryFn: QueryFn = async (): Promise<QueryResult> =>
    createQueryResult([
      createCatalogRow(
        "session-emoji",
        title,
        "2026-07-26T14:00:00.000000Z",
        "idle",
        "1",
      ),
    ]);

  const page = await listChatSessionsWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    1,
    null,
  );

  assert.equal(Array.from(title).length, 200);
  assert.equal(title.length, 400);
  assert.equal(page.sessions[0]?.title, title);
});

test("listChatSessionsWithQuery rejects invalid status and invalidation version rows", async (): Promise<void> => {
  const invalidRows = [
    {
      ...createCatalogRow(
        "session-1",
        "Invalid status",
        "2026-07-26T14:00:00.000000Z",
        "idle",
        "1",
      ),
      status: "queued",
    },
    createCatalogRow(
      "session-1",
      "Invalid version",
      "2026-07-26T14:00:00.000000Z",
      "idle",
      "-1",
    ),
  ] as const;

  for (const row of invalidRows) {
    const queryFn: QueryFn = async (): Promise<QueryResult> =>
      createQueryResult([row]);

    await assert.rejects(
      listChatSessionsWithQuery(
        queryFn,
        "user-1",
        "workspace-1",
        1,
        null,
      ),
      /Invalid chat session catalog database row/,
    );
  }
});
