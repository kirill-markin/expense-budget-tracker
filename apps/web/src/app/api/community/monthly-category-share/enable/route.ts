import {
  DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES,
  postEnableMonthlyCategoryShareRouteWithDeps,
} from "@/server/api/monthlyCategoryShareSettings";

export const POST = async (request: Request): Promise<Response> =>
  postEnableMonthlyCategoryShareRouteWithDeps(request, DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES);
