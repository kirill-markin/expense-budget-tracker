import { fillBudgetBase } from "@/server/budget/fillBudgetBase";

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

  if (typeof category !== "string" || category.length === 0) {
    return new Response("Invalid category. Expected non-empty string", { status: 400 });
  }

  if (typeof baseValue !== "number" || !Number.isFinite(baseValue)) {
    return new Response("Invalid baseValue. Expected finite number", { status: 400 });
  }

  try {
    const filled = await fillBudgetBase({ fromMonth, direction, category, baseValue });
    return Response.json({ ok: true, monthsFilled: filled });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database insert failed: ${message}`, { status: 500 });
  }
};
