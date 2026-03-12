import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS, SUPPORTED_LOCALES, NUMBER_FORMATS, DATE_FORMATS, type SupportedLocale, type NumberFormat, type DateFormat } from "@/lib/locale";
import { getLocaleFromRequest } from "@/lib/localeCookie";
import { handleRoute } from "@/server/api/handleRoute";
import { parseUserSettingsBody } from "@/server/api/settings";
import { parseJsonBody } from "@/server/api/validation";
import { getUserSettings, updateUserSettings } from "@/server/userSettings";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/user-settings", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      if (isDemoModeFromRequest(request)) {
        return Response.json(DEFAULT_USER_SETTINGS);
      }
      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const initialLocale = getLocaleFromRequest(request);
      const settings = await getUserSettings(userId, workspaceId, initialLocale);
      return Response.json(settings);
    },
  );

export const PUT = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/user-settings", method: "PUT", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = parseUserSettingsBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        const result: Record<string, unknown> = { ...DEFAULT_USER_SETTINGS };
        if (body.hasLocale) result.locale = body.locale;
        if (body.hasNumberFormat) result.numberFormat = body.numberFormat;
        if (body.hasDateFormat) result.dateFormat = body.dateFormat;
        const responseHeaders = new Headers({ "Content-Type": "application/json" });
        if (body.hasLocale) {
          responseHeaders.set("Set-Cookie", `locale=${body.locale as string}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
        }
        return new Response(JSON.stringify(result), { headers: responseHeaders });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const initialLocale = getLocaleFromRequest(request);
      const updates: {
        locale?: SupportedLocale;
        numberFormat?: NumberFormat;
        dateFormat?: DateFormat;
      } = {};
      if (body.hasLocale) updates.locale = body.locale as SupportedLocale;
      if (body.hasNumberFormat) updates.numberFormat = body.numberFormat as NumberFormat;
      if (body.hasDateFormat) updates.dateFormat = body.dateFormat as DateFormat;

      const result = await updateUserSettings(userId, workspaceId, updates, initialLocale);
      const responseHeaders = new Headers({ "Content-Type": "application/json" });
      if (body.hasLocale) {
        responseHeaders.set("Set-Cookie", `locale=${result.locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
      }
      return new Response(JSON.stringify(result), { headers: responseHeaders });
    },
  );
