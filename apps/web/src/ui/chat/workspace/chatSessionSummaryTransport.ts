import { fetchWithCsrf } from "@/lib/csrf";

export type ChatSessionStatus = "idle" | "running" | "interrupted";

export type ChatSessionSummary = Readonly<{
  sessionId: string;
  title: string;
  lastMessageAt: string;
  status: ChatSessionStatus;
  mainContentInvalidationVersion: number;
}>;

export type ChatSessionSummaryPage = Readonly<{
  sessions: ReadonlyArray<ChatSessionSummary>;
  nextCursor: string | null;
}>;

const MAX_SESSION_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2048;
const MIN_PAGE_LIMIT = 1;
const MAX_PAGE_LIMIT = 100;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasCodePointLengthBetween = (
  value: string,
  minimumLength: number,
  maximumLength: number,
): boolean => {
  const length = Array.from(value).length;
  return length >= minimumLength && length <= maximumLength;
};

export const parseChatIdentifier = (
  value: unknown,
  context: string,
): string => {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string`);
  }
  if (!value.isWellFormed()) {
    throw new Error(`${context} must be well-formed Unicode`);
  }
  if (!hasCodePointLengthBetween(value, 1, MAX_SESSION_ID_LENGTH)) {
    throw new Error(
      `${context} must contain 1-${MAX_SESSION_ID_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${context} must not contain control characters`);
  }

  return value;
};

export const parseChatSessionTimestamp = (
  value: unknown,
  context: string,
): string => {
  if (
    typeof value !== "string"
    || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)
    || value.startsWith("0000-")
  ) {
    throw new Error(
      `${context} must be a canonical UTC timestamp with millisecond precision`,
    );
  }

  const timestamp = Date.parse(value);
  if (
    Number.isNaN(timestamp)
    || new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(
      `${context} must be a valid canonical UTC timestamp with millisecond precision`,
    );
  }

  return value;
};

const parseTitle = (
  value: unknown,
  context: string,
): string => {
  if (
    typeof value !== "string"
    || !value.isWellFormed()
    || !hasCodePointLengthBetween(value, 1, MAX_TITLE_LENGTH)
  ) {
    throw new Error(`${context} must contain 1-${MAX_TITLE_LENGTH} Unicode characters`);
  }

  return value;
};

const parseStatus = (
  value: unknown,
  context: string,
): ChatSessionStatus => {
  if (value !== "idle" && value !== "running" && value !== "interrupted") {
    throw new Error(`${context} must be idle, running, or interrupted`);
  }

  return value;
};

const parseInvalidationVersion = (
  value: unknown,
  context: string,
): number => {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`${context} must be a non-negative safe integer`);
  }

  return value;
};

const isCanonicalBase64Url = (value: string): boolean => {
  if (value.length % 4 === 1) {
    return false;
  }

  const base64Value = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");

  try {
    const decodedValue = atob(base64Value);
    const reencodedValue = btoa(decodedValue)
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    return reencodedValue === value;
  } catch {
    return false;
  }
};

const parseCursor = (
  value: unknown,
  context: string,
): string | null => {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CURSOR_LENGTH
    || !BASE64_URL_PATTERN.test(value)
  ) {
    throw new Error(
      `${context} must be null or a non-empty base64url string no longer than ${MAX_CURSOR_LENGTH} characters`,
    );
  }
  if (!isCanonicalBase64Url(value)) {
    throw new Error(`${context} must use canonical base64url encoding`);
  }

  return value;
};

const parseSummary = (
  value: unknown,
  index: number,
): ChatSessionSummary => {
  const context = `Invalid chat session catalog response sessions[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  return {
    sessionId: parseChatIdentifier(value.sessionId, `${context}.sessionId`),
    title: parseTitle(value.title, `${context}.title`),
    lastMessageAt: parseChatSessionTimestamp(
      value.lastMessageAt,
      `${context}.lastMessageAt`,
    ),
    status: parseStatus(value.status, `${context}.status`),
    mainContentInvalidationVersion: parseInvalidationVersion(
      value.mainContentInvalidationVersion,
      `${context}.mainContentInvalidationVersion`,
    ),
  };
};

export const parseChatSessionSummaryPage = (
  value: unknown,
): ChatSessionSummaryPage => {
  if (!isRecord(value)) {
    throw new Error("Invalid chat session catalog response: response must be an object");
  }
  if (!Array.isArray(value.sessions)) {
    throw new Error("Invalid chat session catalog response: sessions must be an array");
  }

  return {
    sessions: value.sessions.map(parseSummary),
    nextCursor: parseCursor(
      value.nextCursor,
      "Invalid chat session catalog response nextCursor",
    ),
  };
};

export const mergeChatSessionSummaries = (
  currentSummaries: ReadonlyArray<ChatSessionSummary>,
  nextSummaries: ReadonlyArray<ChatSessionSummary>,
): ReadonlyArray<ChatSessionSummary> => {
  const mergedSummaries: Array<ChatSessionSummary> = [];
  const summaryIndexes = new Map<string, number>();

  for (const summary of [...currentSummaries, ...nextSummaries]) {
    const existingIndex = summaryIndexes.get(summary.sessionId);
    if (existingIndex === undefined) {
      summaryIndexes.set(summary.sessionId, mergedSummaries.length);
      mergedSummaries.push(summary);
      continue;
    }

    mergedSummaries[existingIndex] = summary;
  }

  return mergedSummaries;
};

const requirePageLimit = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit)
    || limit < MIN_PAGE_LIMIT
    || limit > MAX_PAGE_LIMIT
  ) {
    throw new Error(
      `Chat session catalog limit must be an integer between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}`,
    );
  }

  return limit;
};

const requireRequestCursor = (cursor: string | null): string | null =>
  parseCursor(cursor, "Chat session catalog cursor");

export const readChatSessionSummaryPageResponse = async (
  response: Response,
): Promise<ChatSessionSummaryPage> => {
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Chat session catalog request failed: status=${response.status}, responseBody=${responseBody}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Chat session catalog response was not valid JSON: ${reason}. Response body: ${responseBody}`,
    );
  }

  try {
    return parseChatSessionSummaryPage(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}. Response body: ${responseBody}`,
    );
  }
};

export const fetchChatSessionSummaryPage = async (
  limit: number,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ChatSessionSummaryPage> => {
  const searchParams = new URLSearchParams({
    limit: String(requirePageLimit(limit)),
  });
  const validCursor = requireRequestCursor(cursor);
  if (validCursor !== null) {
    searchParams.set("cursor", validCursor);
  }

  const response = await fetchWithCsrf(
    `/api/chat/sessions?${searchParams.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    },
  );

  return readChatSessionSummaryPageResponse(response);
};
