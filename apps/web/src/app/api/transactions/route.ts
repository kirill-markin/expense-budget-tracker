import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getTransactionsPage } from "@/server/transactions/getTransactions";
import { getDemoTransactionsPage } from "@/server/demo/data";
import type { TransactionsFilter } from "@/server/transactions/getTransactions";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const VALID_SORT_KEYS = new Set([
  "ts", "accountId", "amount", "amountAbs", "amountUsdAbs", "currency", "kind", "category", "counterparty",
]);

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const params = url.searchParams;

  const limitRaw = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const offsetRaw = Number(params.get("offset") ?? 0);
  const sortKeyRaw = params.get("sortKey") ?? "ts";
  const sortDirRaw = params.get("sortDir") ?? "desc";

  if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return new Response(`limit must be 1..${MAX_LIMIT}`, { status: 400 });
  }
  if (!Number.isFinite(offsetRaw) || offsetRaw < 0) {
    return new Response("offset must be >= 0", { status: 400 });
  }
  if (!VALID_SORT_KEYS.has(sortKeyRaw)) {
    return new Response(`sortKey must be one of: ${[...VALID_SORT_KEYS].join(", ")}`, { status: 400 });
  }
  if (sortDirRaw !== "asc" && sortDirRaw !== "desc") {
    return new Response("sortDir must be asc or desc", { status: 400 });
  }

  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  const accountId = params.get("accountId");
  const kindFilter = params.get("kind");
  const categoryFilter = params.get("category");

  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  if (dateFrom !== null && !DATE_PATTERN.test(dateFrom)) {
    return new Response("dateFrom must be YYYY-MM-DD", { status: 400 });
  }
  if (dateTo !== null && !DATE_PATTERN.test(dateTo)) {
    return new Response("dateTo must be YYYY-MM-DD", { status: 400 });
  }
  if (accountId !== null && accountId.length > 200) {
    return new Response("accountId too long (max 200 chars)", { status: 400 });
  }
  if (kindFilter !== null && kindFilter.length > 20) {
    return new Response("kind too long (max 20 chars)", { status: 400 });
  }
  if (categoryFilter !== null && categoryFilter.length > 200) {
    return new Response("category too long (max 200 chars)", { status: 400 });
  }

  const filter: TransactionsFilter = {
    dateFrom,
    dateTo,
    accountId,
    kind: kindFilter,
    category: categoryFilter,
    sortKey: sortKeyRaw,
    sortDir: sortDirRaw,
    limit: limitRaw,
    offset: offsetRaw,
  };

  if (isDemoModeFromRequest(request)) {
    return Response.json(getDemoTransactionsPage(filter));
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const page = await getTransactionsPage(userId, workspaceId, filter);
    return Response.json(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("transactions GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};
