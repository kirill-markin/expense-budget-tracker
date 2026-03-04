import { isDemoModeFromRequest } from "@/lib/demoMode";
import { queryAs } from "@/server/db";
import { getFilteredCategories, updateFilteredCategories } from "@/server/filteredCategories";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";
import { getReportCurrency } from "@/server/reportCurrency";
import { updateReportCurrency } from "@/server/updateReportCurrency";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type WorkspaceExtras = Readonly<{ firstDayOfWeek: number; timezone: string }>;

const getWorkspaceExtras = async (userId: string, workspaceId: string): Promise<WorkspaceExtras> => {
  const result = await queryAs(
    userId, workspaceId,
    "SELECT first_day_of_week, timezone FROM workspace_settings WHERE workspace_id = $1",
    [workspaceId],
  );
  if (result.rows.length === 0) {
    return { firstDayOfWeek: 1, timezone: "UTC" };
  }
  const row = result.rows[0] as { first_day_of_week: number; timezone: string };
  return { firstDayOfWeek: row.first_day_of_week, timezone: row.timezone };
};

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json({
      reportingCurrency: "USD",
      availableCurrencies: ["EUR", "GBP", "USD"],
      filteredCategories: null,
      firstDayOfWeek: 1,
      timezone: "UTC",
    });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const [reportingCurrency, availableCurrencies, filteredCategories, extras] = await Promise.all([
      getReportCurrency(userId, workspaceId),
      getAvailableCurrencies(),
      getFilteredCategories(userId, workspaceId),
      getWorkspaceExtras(userId, workspaceId),
    ]);
    return Response.json({ reportingCurrency, availableCurrencies, filteredCategories, ...extras });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("workspace-settings GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};

type PutBody = Readonly<{
  reportingCurrency?: unknown;
  filteredCategories?: unknown;
  firstDayOfWeek?: unknown;
  timezone?: unknown;
}>;

export const PUT = async (request: Request): Promise<Response> => {
  let body: PutBody;
  try {
    body = await request.json() as PutBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { reportingCurrency, filteredCategories, firstDayOfWeek, timezone } = body;

  const hasReportingCurrency = reportingCurrency !== undefined;
  const hasFilteredCategories = filteredCategories !== undefined;
  const hasFirstDayOfWeek = firstDayOfWeek !== undefined;
  const hasTimezone = timezone !== undefined;

  if (!hasReportingCurrency && !hasFilteredCategories && !hasFirstDayOfWeek && !hasTimezone) {
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

  if (hasFirstDayOfWeek) {
    if (typeof firstDayOfWeek !== "number" || !Number.isInteger(firstDayOfWeek) || firstDayOfWeek < 1 || firstDayOfWeek > 7) {
      return new Response("Invalid firstDayOfWeek. Expected integer 1-7", { status: 400 });
    }
  }

  if (hasTimezone) {
    if (typeof timezone !== "string" || timezone.length === 0) {
      return new Response("Invalid timezone. Expected non-empty string", { status: 400 });
    }
  }

  if (isDemoModeFromRequest(request)) {
    const result: Record<string, unknown> = {};
    if (hasReportingCurrency) result.reportingCurrency = reportingCurrency;
    if (hasFilteredCategories) result.filteredCategories = filteredCategories;
    if (hasFirstDayOfWeek) result.firstDayOfWeek = firstDayOfWeek;
    if (hasTimezone) result.timezone = timezone;
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

    if (hasFirstDayOfWeek || hasTimezone) {
      const setClauses: Array<string> = [];
      const params: Array<unknown> = [workspaceId];
      let idx = 2;
      if (hasFirstDayOfWeek) {
        setClauses.push(`first_day_of_week = $${idx}`);
        params.push(firstDayOfWeek);
        idx++;
      }
      if (hasTimezone) {
        setClauses.push(`timezone = $${idx}`);
        params.push(timezone);
        idx++;
      }
      const updated = await queryAs(
        userId, workspaceId,
        `UPDATE workspace_settings SET ${setClauses.join(", ")} WHERE workspace_id = $1 RETURNING first_day_of_week, timezone`,
        params,
      );
      if (updated.rows.length > 0) {
        const row = updated.rows[0] as { first_day_of_week: number; timezone: string };
        result.firstDayOfWeek = row.first_day_of_week;
        result.timezone = row.timezone;
      }
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("workspace-settings PUT: %s", message);
    return new Response("Database update failed", { status: 500 });
  }
};
