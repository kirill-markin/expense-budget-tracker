import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseWorkspaceSettingsBody } from "@/server/api/settings";
import { parseJsonBody } from "@/server/api/validation";
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

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspace-settings", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
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
      const [reportingCurrency, availableCurrencies, filteredCategories, extras] = await Promise.all([
        getReportCurrency(userId, workspaceId),
        getAvailableCurrencies(),
        getFilteredCategories(userId, workspaceId),
        getWorkspaceExtras(userId, workspaceId),
      ]);
      return Response.json({ reportingCurrency, availableCurrencies, filteredCategories, ...extras });
    },
  );

export const PUT = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspace-settings", method: "PUT", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = parseWorkspaceSettingsBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        const result: Record<string, unknown> = {};
        if (body.hasReportingCurrency) result.reportingCurrency = body.reportingCurrency;
        if (body.hasFilteredCategories) result.filteredCategories = body.filteredCategories;
        if (body.hasFirstDayOfWeek) result.firstDayOfWeek = body.firstDayOfWeek;
        if (body.hasTimezone) result.timezone = body.timezone;
        return Response.json(result);
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const result: Record<string, unknown> = {};

      if (body.hasReportingCurrency) {
        result.reportingCurrency = await updateReportCurrency(userId, workspaceId, body.reportingCurrency as string);
      }

      if (body.hasFilteredCategories) {
        result.filteredCategories = await updateFilteredCategories(
          userId,
          workspaceId,
          body.filteredCategories as ReadonlyArray<string> | null,
        );
      }

      if (body.hasFirstDayOfWeek || body.hasTimezone) {
        const setClauses: Array<string> = [];
        const params: Array<unknown> = [workspaceId];
        let idx = 2;
        if (body.hasFirstDayOfWeek) {
          setClauses.push(`first_day_of_week = $${idx}`);
          params.push(body.firstDayOfWeek);
          idx++;
        }
        if (body.hasTimezone) {
          setClauses.push(`timezone = $${idx}`);
          params.push(body.timezone);
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
    },
  );
