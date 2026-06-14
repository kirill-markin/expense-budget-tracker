import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  postDisableMonthlyCategoryShareRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const POST = async (request: Request): Promise<Response> =>
  postDisableMonthlyCategoryShareRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
