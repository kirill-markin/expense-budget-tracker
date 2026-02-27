import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getFilteredCategories, updateFilteredCategories } from "@/server/filteredCategories";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";
import { getReportCurrency } from "@/server/reportCurrency";
import { updateReportCurrency } from "@/server/updateReportCurrency";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json({
      reportingCurrency: "USD",
      availableCurrencies: ["EUR", "GBP", "USD"],
      filteredCategories: null,
    });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const [reportingCurrency, availableCurrencies, filteredCategories] = await Promise.all([
      getReportCurrency(userId, workspaceId),
      getAvailableCurrencies(),
      getFilteredCategories(userId, workspaceId),
    ]);
    return Response.json({ reportingCurrency, availableCurrencies, filteredCategories });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("workspace-settings GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};

type PutBody = Readonly<{
  reportingCurrency?: unknown;
  filteredCategories?: unknown;
}>;

export const PUT = async (request: Request): Promise<Response> => {
  let body: PutBody;
  try {
    body = await request.json() as PutBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { reportingCurrency, filteredCategories } = body;

  const hasReportingCurrency = reportingCurrency !== undefined;
  const hasFilteredCategories = filteredCategories !== undefined;

  if (!hasReportingCurrency && !hasFilteredCategories) {
    return new Response("No fields to update", { status: 400 });
  }

  if (hasReportingCurrency) {
    if (typeof reportingCurrency !== "string" || !/^[A-Z]{3}$/.test(reportingCurrency)) {
      return new Response("Invalid reportingCurrency. Expected 3-letter ISO 4217 code", { status: 400 });
    }
  }

  if (hasFilteredCategories) {
    if (filteredCategories !== null && (!Array.isArray(filteredCategories) || !filteredCategories.every((c: unknown) => typeof c === "string"))) {
      return new Response("Invalid filteredCategories. Expected array of strings or null", { status: 400 });
    }
  }

  if (isDemoModeFromRequest(request)) {
    const result: Record<string, unknown> = {};
    if (hasReportingCurrency) result.reportingCurrency = reportingCurrency;
    if (hasFilteredCategories) result.filteredCategories = filteredCategories;
    return Response.json(result);
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const result: Record<string, unknown> = {};

    if (hasReportingCurrency) {
      result.reportingCurrency = await updateReportCurrency(userId, workspaceId, reportingCurrency as string);
    }

    if (hasFilteredCategories) {
      result.filteredCategories = await updateFilteredCategories(
        userId,
        workspaceId,
        filteredCategories as ReadonlyArray<string> | null,
      );
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("workspace-settings PUT: %s", message);
    return new Response("Database update failed", { status: 500 });
  }
};
