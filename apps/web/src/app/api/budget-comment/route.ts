import { getLatestComment } from "@/server/budget/getLatestComment";
import { insertBudgetComment } from "@/server/budget/insertBudgetComment";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const VALID_DIRECTIONS = new Set(["income", "spend"]);

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const url = new URL(request.url);
  const month = url.searchParams.get("month");
  const direction = url.searchParams.get("direction");
  const category = url.searchParams.get("category");

  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
    return new Response("Invalid direction. Expected 'income' or 'spend'", { status: 400 });
  }

  if (typeof category !== "string" || category.length === 0) {
    return new Response("Invalid category. Expected non-empty string", { status: 400 });
  }

  try {
    const comment = await getLatestComment(userId, workspaceId, { month, direction, category });
    return Response.json({ comment });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database query failed: ${message}`, { status: 500 });
  }
};

type PostBody = Readonly<{
  month: unknown;
  direction: unknown;
  category: unknown;
  comment: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let body: PostBody;
  try {
    body = await request.json() as PostBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { month, direction, category, comment } = body;

  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (typeof direction !== "string" || !VALID_DIRECTIONS.has(direction)) {
    return new Response("Invalid direction. Expected 'income' or 'spend'", { status: 400 });
  }

  if (typeof category !== "string" || category.length === 0) {
    return new Response("Invalid category. Expected non-empty string", { status: 400 });
  }

  if (typeof comment !== "string") {
    return new Response("Invalid comment. Expected string", { status: 400 });
  }

  try {
    await insertBudgetComment(userId, workspaceId, { month, direction, category, comment });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database insert failed: ${message}`, { status: 500 });
  }
};
