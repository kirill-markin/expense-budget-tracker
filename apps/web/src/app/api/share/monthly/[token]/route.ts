import { ApiRouteError } from "@/server/api/errors";
import { applyNoStoreHeaders, jsonNoStore } from "@/server/api/noStore";
import { parsePublicMonthWindowQuery } from "@/server/community/months";
import { getPublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShare";
import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import { log } from "@/server/logger";

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

const DEFAULT_PUBLIC_MONTHLY_SHARE_ROUTE_DEPENDENCIES: PublicMonthlyShareRouteDependencies = {
  getPublicMonthlyCategoryShare,
};

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const buildPublicHeaders = (headers: HeadersInit): Headers => {
  const result = new Headers(CORS_HEADERS);
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

export const getPublicMonthlyShareRouteWithDeps = async (
  request: Request,
  context: RouteContext,
  dependencies: PublicMonthlyShareRouteDependencies,
): Promise<Response> => {
  try {
    const { token } = await context.params;
    const query = parsePublicMonthWindowQuery(new URL(request.url).searchParams);
    const share = await dependencies.getPublicMonthlyCategoryShare(
      token,
      query.monthFrom,
      query.monthTo,
    );

    if (share === null) {
      return missingPublicShareResponse();
    }

    return jsonPublicNoStore(share, { status: 200 });
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
    headers: applyNoStoreHeaders(CORS_HEADERS),
  });
