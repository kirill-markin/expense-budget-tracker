import { ApiRouteError } from "@/server/api/errors";
import { applyNoStoreHeaders, jsonNoStore } from "@/server/api/noStore";
import { parsePublicMonthWindowQuery } from "@/server/community/months";
import { getPublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShare";
import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import { log } from "@/server/logger";
import { getCurrentMonth, offsetMonth } from "@/lib/monthUtils";

export const dynamic = "force-dynamic";

type RouteContext = Readonly<{
  params: Promise<{
    token: string;
  }>;
}>;

type PublicMonthlyShareRouteDependencies = Readonly<{
  getPublicMonthlyCategoryShare: (
    publicToken: string,
    monthFrom: string,
    monthTo: string,
  ) => Promise<PublicMonthlyCategoryShare | null>;
}>;

type PublicMonthlyShareWindow = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

const DEFAULT_PUBLIC_MONTHLY_SHARE_ROUTE_DEPENDENCIES: PublicMonthlyShareRouteDependencies = {
  getPublicMonthlyCategoryShare,
};

const DEFAULT_PUBLIC_MONTHLY_SHARE_ROUTE_WINDOW_MONTHS = 12;

const PUBLIC_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "X-Robots-Tag": "noindex, nofollow",
};

const buildPublicHeaders = (headers: HeadersInit): Headers => {
  const result = new Headers(PUBLIC_HEADERS);
  const providedHeaders = new Headers(headers);
  providedHeaders.forEach((value: string, key: string): void => {
    result.set(key, value);
  });
  return result;
};

const jsonPublicNoStore = (
  body: unknown,
  init: ResponseInit,
): Response =>
  jsonNoStore(body, {
    ...init,
    headers: buildPublicHeaders(init.headers ?? {}),
  });

const missingPublicShareResponse = (): Response =>
  jsonPublicNoStore({ error: "Public monthly share not found" }, { status: 404 });

const badRequestResponse = (message: string): Response =>
  jsonPublicNoStore({ error: message }, { status: 400 });

const internalErrorResponse = (): Response =>
  jsonPublicNoStore({ error: "Public monthly share is temporarily unavailable" }, { status: 500 });

const toPublicMonthlyShareResponseBody = (
  share: PublicMonthlyCategoryShare,
): PublicMonthlyCategoryShare => ({
  label: share.label,
  currency: share.currency,
  availableMonthFrom: share.availableMonthFrom,
  availableMonthTo: share.availableMonthTo,
  loadedMonthFrom: share.loadedMonthFrom,
  loadedMonthTo: share.loadedMonthTo,
  categories: share.categories.map((category) => ({
    category: category.category,
    accessLevel: category.accessLevel,
  })),
  cells: share.cells.map((cell) => ({
    month: cell.month,
    category: cell.category,
    amount: cell.amount,
  })),
  yearTotals: share.yearTotals.map((total) => ({
    year: total.year,
    category: total.category,
    amount: total.amount,
  })),
});

const maxMonth = (left: string, right: string): string =>
  left > right ? left : right;

const buildDefaultPublicMonthlyShareProbeWindow = (): PublicMonthlyShareWindow => {
  const previousMonth = offsetMonth(getCurrentMonth(), -1);
  return {
    monthFrom: previousMonth,
    monthTo: previousMonth,
  };
};

const buildLatestPublicMonthlyShareWindow = (
  availableMonthFrom: string | null,
  availableMonthTo: string | null,
): PublicMonthlyShareWindow | null => {
  if (availableMonthFrom === null || availableMonthTo === null) {
    return null;
  }
  const candidateFrom = offsetMonth(availableMonthTo, -(DEFAULT_PUBLIC_MONTHLY_SHARE_ROUTE_WINDOW_MONTHS - 1));
  return {
    monthFrom: maxMonth(availableMonthFrom, candidateFrom),
    monthTo: availableMonthTo,
  };
};

const readDefaultPublicMonthlyShare = async (
  token: string,
  dependencies: PublicMonthlyShareRouteDependencies,
): Promise<PublicMonthlyCategoryShare | null> => {
  const probeWindow = buildDefaultPublicMonthlyShareProbeWindow();
  const probeShare = await dependencies.getPublicMonthlyCategoryShare(
    token,
    probeWindow.monthFrom,
    probeWindow.monthTo,
  );
  if (probeShare === null) {
    return null;
  }

  const latestWindow = buildLatestPublicMonthlyShareWindow(
    probeShare.availableMonthFrom,
    probeShare.availableMonthTo,
  );
  if (latestWindow === null) {
    return probeShare;
  }

  return dependencies.getPublicMonthlyCategoryShare(
    token,
    latestWindow.monthFrom,
    latestWindow.monthTo,
  );
};

export const getPublicMonthlyShareRouteWithDeps = async (
  request: Request,
  context: RouteContext,
  dependencies: PublicMonthlyShareRouteDependencies,
): Promise<Response> => {
  try {
    const { token } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    const monthFrom = searchParams.get("monthFrom");
    const monthTo = searchParams.get("monthTo");
    const explicitWindow = monthFrom === null && monthTo === null
      ? null
      : parsePublicMonthWindowQuery(searchParams);
    const share = explicitWindow === null
      ? await readDefaultPublicMonthlyShare(token, dependencies)
      : await dependencies.getPublicMonthlyCategoryShare(
        token,
        explicitWindow.monthFrom,
        explicitWindow.monthTo,
      );

    if (share === null) {
      return missingPublicShareResponse();
    }

    return jsonPublicNoStore(toPublicMonthlyShareResponseBody(share), { status: 200 });
  } catch (error) {
    if (error instanceof ApiRouteError) {
      return badRequestResponse(error.publicMessage);
    }

    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "api", action: "error", route: "/api/share/monthly/[token]", method: "GET", error: message });
    return internalErrorResponse();
  }
};

export const GET = async (
  request: Request,
  context: RouteContext,
): Promise<Response> =>
  getPublicMonthlyShareRouteWithDeps(
    request,
    context,
    DEFAULT_PUBLIC_MONTHLY_SHARE_ROUTE_DEPENDENCIES,
  );

export const OPTIONS = (): Response =>
  new Response(null, {
    status: 204,
    headers: applyNoStoreHeaders(PUBLIC_HEADERS),
  });
