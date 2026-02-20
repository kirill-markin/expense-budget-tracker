import { validateSession } from "@/server/auth/session";
import { getTransactionsPage } from "@/server/transactions/getTransactions";
import type { TransactionsFilter } from "@/server/transactions/getTransactions";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const VALID_SORT_KEYS = new Set([
  "ts", "accountId", "amount", "amountAbs", "amountUsdAbs", "currency", "kind", "category", "counterparty",
]);

export const GET = async (request: Request): Promise<Response> => {
  try {
    await validateSession(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Unauthorized: ${message}`, { status: 401 });
  }

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

  const filter: TransactionsFilter = {
    dateFrom: params.get("dateFrom"),
    dateTo: params.get("dateTo"),
    accountId: params.get("accountId"),
    kind: params.get("kind"),
    category: params.get("category"),
    sortKey: sortKeyRaw,
    sortDir: sortDirRaw,
    limit: limitRaw,
    offset: offsetRaw,
  };

  const page = await getTransactionsPage(filter);
  return Response.json(page);
};
