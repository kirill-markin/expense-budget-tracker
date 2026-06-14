import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  getMonthlyCategoryShareSettingsRouteWithDeps,
  putMonthlyCategoryShareSettingsRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const GET = async (request: Request): Promise<Response> =>
  getMonthlyCategoryShareSettingsRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);

export const PUT = async (request: Request): Promise<Response> =>
  putMonthlyCategoryShareSettingsRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
