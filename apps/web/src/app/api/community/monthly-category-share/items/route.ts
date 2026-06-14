import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  putMonthlyCategoryShareItemsRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const PUT = async (request: Request): Promise<Response> =>
  putMonthlyCategoryShareItemsRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
