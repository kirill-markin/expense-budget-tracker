import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS, type AutoFilterDelayMinutes, type SupportedLocale, type NumberFormat, type DateFormat } from "@/lib/locale";
import { getLowercaseFromRequest } from "@/lib/lowercaseCookie";
import {
  appLocaleSetCookie,
  demoLocaleSetCookie,
  getInitialLocale,
  getLocaleFromRequest,
  readAppLocaleCookie,
} from "@/lib/localeCookie";
import type { ThemePreference } from "@/lib/theme";
import { getThemeFromRequest } from "@/lib/themeCookie";
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
        return Response.json({ ...DEFAULT_USER_SETTINGS, locale: getLocaleFromRequest(request), theme: getThemeFromRequest(request), lowercase: getLowercaseFromRequest(request) });
      }
      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const initialLocale = getInitialLocale(request.headers, request.url);
      const settings = await getUserSettings(userId, workspaceId, initialLocale);
      const response = Response.json(settings, { headers: { "Cache-Control": "private, no-store" } });
      if (readAppLocaleCookie(request.headers) !== settings.locale) {
        response.headers.append("Set-Cookie", appLocaleSetCookie(settings.locale));
      }
      return response;
    },
  );

export const PUT = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/user-settings", method: "PUT", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = parseUserSettingsBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        const result: Record<string, unknown> = {
          ...DEFAULT_USER_SETTINGS,
          locale: getLocaleFromRequest(request),
          theme: getThemeFromRequest(request),
          lowercase: getLowercaseFromRequest(request),
        };
        if (body.hasLocale) result.locale = body.locale;
        if (body.hasNumberFormat) result.numberFormat = body.numberFormat;
        if (body.hasDateFormat) result.dateFormat = body.dateFormat;
        if (body.hasAutoFilterDelayMinutes) result.autoFilterDelayMinutes = body.autoFilterDelayMinutes;
        if (body.hasTheme) result.theme = body.theme;
        if (body.hasLowercase) result.lowercase = body.lowercase;
        const responseHeaders = new Headers({ "Content-Type": "application/json" });
        if (body.hasLocale) {
          responseHeaders.append("Set-Cookie", demoLocaleSetCookie(body.locale as SupportedLocale));
        }
        if (body.hasTheme) {
          responseHeaders.append("Set-Cookie", `theme=${body.theme as string}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
        }
        if (body.hasLowercase) {
          responseHeaders.append("Set-Cookie", `lowercase=${String(body.lowercase)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
        }
        return new Response(JSON.stringify(result), { headers: responseHeaders });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const initialLocale = getInitialLocale(request.headers, request.url);
      const updates: {
        locale?: SupportedLocale;
        numberFormat?: NumberFormat;
        dateFormat?: DateFormat;
        autoFilterDelayMinutes?: AutoFilterDelayMinutes;
        theme?: ThemePreference;
        lowercase?: boolean;
      } = {};
      if (body.hasLocale) updates.locale = body.locale as SupportedLocale;
      if (body.hasNumberFormat) updates.numberFormat = body.numberFormat as NumberFormat;
      if (body.hasDateFormat) updates.dateFormat = body.dateFormat as DateFormat;
      if (body.hasAutoFilterDelayMinutes) updates.autoFilterDelayMinutes = body.autoFilterDelayMinutes as AutoFilterDelayMinutes;
      if (body.hasTheme) updates.theme = body.theme as ThemePreference;
      if (body.hasLowercase) updates.lowercase = body.lowercase;

      const result = await updateUserSettings(userId, workspaceId, updates, initialLocale);
      const responseHeaders = new Headers({ "Content-Type": "application/json" });
      if (body.hasLocale) {
        responseHeaders.append("Set-Cookie", appLocaleSetCookie(result.locale));
      }
      if (body.hasTheme) {
        responseHeaders.append("Set-Cookie", `theme=${result.theme}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
      }
      if (body.hasLowercase) {
        responseHeaders.append("Set-Cookie", `lowercase=${String(result.lowercase)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
      }
      return new Response(JSON.stringify(result), { headers: responseHeaders });
    },
  );
