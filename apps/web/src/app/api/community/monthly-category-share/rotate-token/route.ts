import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  postRotateMonthlyCategoryShareTokenRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const POST = async (request: Request): Promise<Response> =>
  postRotateMonthlyCategoryShareTokenRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
