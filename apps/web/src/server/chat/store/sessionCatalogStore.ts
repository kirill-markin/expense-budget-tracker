import { z } from "zod";

import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  parseMainContentInvalidationVersion,
  type ChatSessionRunState,
} from "./shared";

export type ChatSessionCatalogItem = Readonly<{
  sessionId: string;
  title: string;
  lastMessageAt: string;
  status: ChatSessionRunState;
  mainContentInvalidationVersion: number;
}>;

export type ChatSessionCatalogPage = Readonly<{
  sessions: ReadonlyArray<ChatSessionCatalogItem>;
  nextCursor: string | null;
}>;

export type ChatSessionCatalogCursor = Readonly<{
  lastMessageAt: string;
  sessionId: string;
}>;

const UNTITLED_CHAT_SESSION_TITLE = "Untitled chat";
const MAX_CURSOR_LENGTH = 2048;
const MAX_SESSION_ID_LENGTH = 200;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const EXACT_UTC_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.)(\d{6})Z$/;

const hasCodePointLengthBetween = (
  value: string,
  minLength: number,
  maxLength: number,
): boolean => {
  const length = Array.from(value).length;
  return length >= minLength && length <= maxLength;
};

const sessionIdSchema = z.string()
  .refine(
    (value: string): boolean => value.isWellFormed(),
    "sessionId must be well-formed Unicode",
  )
  .refine(
    (value: string): boolean =>
      hasCodePointLengthBetween(value, 1, MAX_SESSION_ID_LENGTH),
    `sessionId must contain 1-${MAX_SESSION_ID_LENGTH} characters`,
  )
  .refine(
    (value: string): boolean => !CONTROL_CHARACTER_PATTERN.test(value),
    "sessionId must not contain control characters",
  );

const titleSchema = z.string().refine(
  (value: string): boolean => hasCodePointLengthBetween(value, 1, 200),
  "title must contain 1-200 characters",
);

const exactUtcTimestampSchema = z.string().refine(
  (value: string): boolean => {
    const match = EXACT_UTC_TIMESTAMP_PATTERN.exec(value);
    if (match === null) {
      return false;
    }

    const prefix = match[1];
    const microseconds = match[2];
    if (
      prefix === undefined
      || microseconds === undefined
      || prefix.startsWith("0000-")
    ) {
      return false;
    }

    const millisecondTimestamp = `${prefix}${microseconds.slice(0, 3)}Z`;
    const timestamp = Date.parse(millisecondTimestamp);
    return !Number.isNaN(timestamp)
      && new Date(timestamp).toISOString() === millisecondTimestamp;
  },
  "lastMessageAt must be a canonical UTC timestamp with six fractional digits",
);

const chatSessionCatalogRowSchema = z.object({
  session_id: sessionIdSchema,
  title: titleSchema.nullable(),
  last_message_at_exact: exactUtcTimestampSchema,
  status: z.enum(["idle", "running", "interrupted"]),
  main_content_invalidation_version: z.string().regex(/^\d+$/),
}).strict();

type ChatSessionCatalogRow = z.infer<typeof chatSessionCatalogRowSchema>;

const chatSessionCatalogCursorSchema = z.object({
  lastMessageAt: exactUtcTimestampSchema,
  sessionId: sessionIdSchema,
}).strict();

export class InvalidChatSessionCatalogCursorError extends Error {
  public constructor(reason: string) {
    super(`Invalid chat session cursor: ${reason}`);
    this.name = "InvalidChatSessionCatalogCursorError";
  }
}

const parseChatSessionCatalogCursor = (
  cursor: unknown,
): ChatSessionCatalogCursor => {
  const result = chatSessionCatalogCursorSchema.safeParse(cursor);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "cursor"}: ${issue.message}`)
      .join("; ");
    throw new InvalidChatSessionCatalogCursorError(details);
  }

  return result.data;
};

export const encodeChatSessionCatalogCursor = (
  cursor: ChatSessionCatalogCursor,
): string =>
  Buffer.from(
    JSON.stringify(parseChatSessionCatalogCursor(cursor)),
    "utf8",
  ).toString("base64url");

export const decodeChatSessionCatalogCursor = (
  encodedCursor: string,
): ChatSessionCatalogCursor => {
  if (
    encodedCursor.length === 0
    || encodedCursor.length > MAX_CURSOR_LENGTH
    || !BASE64_URL_PATTERN.test(encodedCursor)
  ) {
    throw new InvalidChatSessionCatalogCursorError(
      "expected a non-empty base64url value",
    );
  }

  let parsedJson: unknown;
  try {
    const cursorBuffer = Buffer.from(encodedCursor, "base64url");
    if (cursorBuffer.toString("base64url") !== encodedCursor) {
      throw new Error("non-canonical base64url");
    }
    const cursorJson = new TextDecoder("utf-8", { fatal: true }).decode(
      cursorBuffer,
    );
    parsedJson = JSON.parse(cursorJson) as unknown;
  } catch {
    throw new InvalidChatSessionCatalogCursorError(
      "value could not be decoded",
    );
  }

  return parseChatSessionCatalogCursor(parsedJson);
};

export const CHAT_SESSION_CATALOG_FIRST_PAGE_QUERY = `
  SELECT
    session_id,
    title,
    to_char(
      last_message_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) AS last_message_at_exact,
    status,
    main_content_invalidation_version
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND last_message_at IS NOT NULL
  ORDER BY last_message_at DESC, session_id DESC
  LIMIT $3
`;

export const CHAT_SESSION_CATALOG_AFTER_CURSOR_QUERY = `
  SELECT
    session_id,
    title,
    to_char(
      last_message_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) AS last_message_at_exact,
    status,
    main_content_invalidation_version
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND last_message_at IS NOT NULL
    AND (last_message_at, session_id) < ($3::timestamptz, $4)
  ORDER BY last_message_at DESC, session_id DESC
  LIMIT $5
`;

const parseChatSessionCatalogRow = (
  row: unknown,
  rowIndex: number,
): ChatSessionCatalogRow => {
  const result = chatSessionCatalogRowSchema.safeParse(row);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid chat session catalog database row at index ${rowIndex}: ${details}`,
    );
  }

  return result.data;
};

const mapChatSessionCatalogRow = (
  row: ChatSessionCatalogRow,
): Readonly<{
  session: ChatSessionCatalogItem;
  cursor: ChatSessionCatalogCursor;
}> => ({
  session: {
    sessionId: row.session_id,
    title: row.title ?? UNTITLED_CHAT_SESSION_TITLE,
    lastMessageAt: `${row.last_message_at_exact.slice(0, -4)}Z`,
    status: row.status,
    mainContentInvalidationVersion: parseMainContentInvalidationVersion(
      row.main_content_invalidation_version,
      "catalog read",
    ),
  },
  cursor: {
    lastMessageAt: row.last_message_at_exact,
    sessionId: row.session_id,
  },
});

export const listChatSessionsWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  limit: number,
  cursor: ChatSessionCatalogCursor | null,
): Promise<ChatSessionCatalogPage> => {
  const fetchLimit = limit + 1;
  const result = cursor === null
    ? await queryFn(
      CHAT_SESSION_CATALOG_FIRST_PAGE_QUERY,
      [userId, workspaceId, fetchLimit],
    )
    : await queryFn(
      CHAT_SESSION_CATALOG_AFTER_CURSOR_QUERY,
      [
        userId,
        workspaceId,
        cursor.lastMessageAt,
        cursor.sessionId,
        fetchLimit,
      ],
    );
  const mappedRows = result.rows.map(
    (row, rowIndex) =>
      mapChatSessionCatalogRow(parseChatSessionCatalogRow(row, rowIndex)),
  );
  const pageRows = mappedRows.slice(0, limit);
  const sessions = pageRows.map(
    (row): ChatSessionCatalogItem => row.session,
  );
  const lastRow = pageRows.at(-1);
  const nextCursor = mappedRows.length > limit && lastRow !== undefined
    ? encodeChatSessionCatalogCursor(lastRow.cursor)
    : null;

  return { sessions, nextCursor };
};

export const listChatSessions = async (
  userId: string,
  workspaceId: string,
  limit: number,
  cursor: ChatSessionCatalogCursor | null,
): Promise<ChatSessionCatalogPage> =>
  withUserContext(
    userId,
    workspaceId,
    async (queryFn): Promise<ChatSessionCatalogPage> =>
      listChatSessionsWithQuery(
        queryFn,
        userId,
        workspaceId,
        limit,
        cursor,
      ),
  );
