import { isDemoModeFromRequest } from "@/lib/demoMode";
import { fillBudgetBase } from "@/server/budget/fillBudgetBase";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const VALID_DIRECTIONS = new Set(["income", "spend"]);

type RequestBody = Readonly<{
  fromMonth: unknown;
  direction: unknown;
  category: unknown;
  baseValue: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { fromMonth, direction, category, baseValue } = body;

  if (typeof fromMonth !== "string" || !MONTH_PATTERN.test(fromMonth)) {
    return new Response("Invalid fromMonth format. Expected YYYY-MM", { status: 400 });
  }

  if (fromMonth.endsWith("-12")) {
    return new Response("Cannot fill from December — no following months in the same year", { status: 400 });
  }

  if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
    return new Response("Invalid direction. Expected 'income' or 'spend'", { status: 400 });
  }

  if (typeof category !== "string" || category.length === 0 || category.length > 200) {
    return new Response("Invalid category. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (typeof baseValue !== "number" || !Number.isFinite(baseValue)) {
    return new Response("Invalid baseValue. Expected finite number", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    const fromNum = Number(fromMonth.slice(5));
    const monthsFilled = 12 - fromNum;
    return Response.json({ ok: true, monthsFilled });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const filled = await fillBudgetBase(userId, workspaceId, { fromMonth, direction, category, baseValue });
    return Response.json({ ok: true, monthsFilled: filled });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("budget-plan-fill POST: %s", message);
    return new Response("Database insert failed", { status: 500 });
  }
};
