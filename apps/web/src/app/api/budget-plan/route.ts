import { insertBudgetPlan } from "@/server/budget/insertBudgetPlan";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const VALID_DIRECTIONS = new Set(["income", "spend"]);
const VALID_KINDS = new Set(["base", "modifier"]);

type RequestBody = Readonly<{
  month: unknown;
  direction: unknown;
  category: unknown;
  kind: unknown;
  plannedValue: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { month, direction, category, kind, plannedValue } = body;

  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
    return new Response("Invalid direction. Expected 'income' or 'spend'", { status: 400 });
  }

  if (typeof category !== "string" || category.length === 0) {
    return new Response("Invalid category. Expected non-empty string", { status: 400 });
  }

  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    return new Response("Invalid kind. Expected 'base' or 'modifier'", { status: 400 });
  }

  if (typeof plannedValue !== "number" || !Number.isFinite(plannedValue)) {
    return new Response("Invalid plannedValue. Expected finite number", { status: 400 });
  }

  try {
    await insertBudgetPlan(userId, workspaceId, {
      month,
      direction,
      category,
      kind: kind as "base" | "modifier",
      plannedValue,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database insert failed: ${message}`, { status: 500 });
  }

  return Response.json({ ok: true });
};
