import { ApiRouteError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import {
  decodeChatSessionCatalogCursor,
  InvalidChatSessionCatalogCursorError,
  listChatSessions,
  type ChatSessionCatalogCursor,
} from "@/server/chat/store";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type SessionCatalogRouteDependencies = Readonly<{
  listChatSessions: typeof listChatSessions;
}>;

type SessionCatalogQuery = Readonly<{
  limit: number;
  cursor: ChatSessionCatalogCursor | null;
}>;

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const DEFAULT_SESSION_CATALOG_ROUTE_DEPENDENCIES: SessionCatalogRouteDependencies = {
  listChatSessions,
};

const parseSessionCatalogLimit = (rawLimit: string | null): number => {
  if (rawLimit === null) {
    return DEFAULT_LIMIT;
  }

  if (!POSITIVE_INTEGER_PATTERN.test(rawLimit)) {
    throw new ApiRouteError(
      400,
      `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    );
  }

  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit)
    || limit < MIN_LIMIT
    || limit > MAX_LIMIT
  ) {
    throw new ApiRouteError(
      400,
      `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    );
  }

  return limit;
};

const parseSessionCatalogCursor = (
  rawCursor: string | null,
): ChatSessionCatalogCursor | null => {
  if (rawCursor === null) {
    return null;
  }

  try {
    return decodeChatSessionCatalogCursor(rawCursor);
  } catch (error) {
    if (error instanceof InvalidChatSessionCatalogCursorError) {
      throw new ApiRouteError(400, error.message);
    }
    throw error;
  }
};

const parseSessionCatalogQuery = (
  searchParams: URLSearchParams,
): SessionCatalogQuery => ({
  limit: parseSessionCatalogLimit(searchParams.get("limit")),
  cursor: parseSessionCatalogCursor(searchParams.get("cursor")),
});

const extractSessionCatalogRequestContext = (
  request: Request,
): Readonly<{
  userId: string;
  workspaceId: string;
}> => {
  try {
    return {
      userId: extractUserId(request),
      workspaceId: extractWorkspaceId(request),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiRouteError(401, message);
  }
};

export const getSessionCatalogRouteWithDeps = async (
  request: Request,
  dependencies: SessionCatalogRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: "/api/chat/sessions",
      method: "GET",
      internalErrorMessage: "Chat session catalog load failed",
    },
    async (): Promise<Response> => {
      const { userId, workspaceId } = extractSessionCatalogRequestContext(request);
      const { limit, cursor } = parseSessionCatalogQuery(
        new URL(request.url).searchParams,
      );
      const page = await dependencies.listChatSessions(
        userId,
        workspaceId,
        limit,
        cursor,
      );
      return jsonNoStore(page);
    },
  );

export const GET = async (request: Request): Promise<Response> =>
  getSessionCatalogRouteWithDeps(
    request,
    DEFAULT_SESSION_CATALOG_ROUTE_DEPENDENCIES,
  );
