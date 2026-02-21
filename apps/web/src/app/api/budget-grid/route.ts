import { getBudgetGrid } from "@/server/budget/getBudgetGrid";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const monthFrom = url.searchParams.get("monthFrom");
  const monthTo = url.searchParams.get("monthTo");
  const planFrom = url.searchParams.get("planFrom");
  const actualTo = url.searchParams.get("actualTo");

  if (monthFrom === null || monthTo === null || planFrom === null || actualTo === null) {
    return new Response("Missing required query params: monthFrom, monthTo, planFrom, actualTo", { status: 400 });
  }

  if (!MONTH_PATTERN.test(monthFrom) || !MONTH_PATTERN.test(monthTo) || !MONTH_PATTERN.test(planFrom) || !MONTH_PATTERN.test(actualTo)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (monthFrom > monthTo) {
    return new Response("monthFrom must be <= monthTo", { status: 400 });
  }

  const grid = await getBudgetGrid(monthFrom, monthTo, planFrom, actualTo);
  return Response.json(grid);
};
