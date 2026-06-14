import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  putMonthlyCategoryShareIndexingRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const PUT = async (request: Request): Promise<Response> =>
  putMonthlyCategoryShareIndexingRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
