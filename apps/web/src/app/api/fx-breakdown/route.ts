import { validateSession } from "@/server/auth/session";
import { getFxBreakdown } from "@/server/budget/getFxBreakdown";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const GET = async (request: Request): Promise<Response> => {
  try {
    await validateSession(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Unauthorized: ${message}`, { status: 401 });
  }

  const url = new URL(request.url);
  const month = url.searchParams.get("month");

  if (month === null) {
    return new Response("Missing required query param: month", { status: 400 });
  }

  if (!MONTH_PATTERN.test(month)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  const result = await getFxBreakdown(month);
  return Response.json(result);
};
