import { isDemoModeFromRequest } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS, SUPPORTED_LOCALES, NUMBER_FORMATS, DATE_FORMATS, type SupportedLocale, type NumberFormat, type DateFormat } from "@/lib/locale";
import { log } from "@/server/logger";
import { getUserSettings, updateUserSettings } from "@/server/userSettings";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json(DEFAULT_USER_SETTINGS);
  }
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  try {
    const settings = await getUserSettings(userId, workspaceId);
    return Response.json(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "api", action: "error", route: "/api/user-settings", method: "GET", error: message });
    return new Response("Database query failed", { status: 500 });
  }
};

type PutBody = Readonly<{ locale?: unknown; numberFormat?: unknown; dateFormat?: unknown }>;

export const PUT = async (request: Request): Promise<Response> => {
  let body: PutBody;
  try { body = await request.json() as PutBody; } catch { return new Response("Invalid JSON body", { status: 400 }); }

  const { locale, numberFormat, dateFormat } = body;
  const hasLocale = locale !== undefined;
  const hasNumberFormat = numberFormat !== undefined;
  const hasDateFormat = dateFormat !== undefined;

  if (!hasLocale && !hasNumberFormat && !hasDateFormat) {
    return new Response("No fields to update", { status: 400 });
  }

  if (hasLocale) {
    if (typeof locale !== "string" || !(SUPPORTED_LOCALES as ReadonlyArray<string>).includes(locale)) {
      return new Response(`Invalid locale. Expected one of: ${SUPPORTED_LOCALES.join(", ")}`, { status: 400 });
    }
  }
  if (hasNumberFormat) {
    if (typeof numberFormat !== "string" || !(NUMBER_FORMATS as ReadonlyArray<string>).includes(numberFormat)) {
      return new Response(`Invalid numberFormat. Expected one of: ${NUMBER_FORMATS.join(", ")}`, { status: 400 });
    }
  }
  if (hasDateFormat) {
    if (typeof dateFormat !== "string" || !(DATE_FORMATS as ReadonlyArray<string>).includes(dateFormat)) {
      return new Response(`Invalid dateFormat. Expected one of: ${DATE_FORMATS.join(", ")}`, { status: 400 });
    }
  }

  if (isDemoModeFromRequest(request)) {
    const result: Record<string, unknown> = { ...DEFAULT_USER_SETTINGS };
    if (hasLocale) result.locale = locale;
    if (hasNumberFormat) result.numberFormat = numberFormat;
    if (hasDateFormat) result.dateFormat = dateFormat;
    const responseHeaders = new Headers({ "Content-Type": "application/json" });
    if (hasLocale) {
      responseHeaders.set("Set-Cookie", `locale=${locale as string}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    }
    return new Response(JSON.stringify(result), { headers: responseHeaders });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  try {
    const updates: Record<string, unknown> = {};
    if (hasLocale) updates.locale = locale as SupportedLocale;
    if (hasNumberFormat) updates.numberFormat = numberFormat as NumberFormat;
    if (hasDateFormat) updates.dateFormat = dateFormat as DateFormat;

    const result = await updateUserSettings(userId, workspaceId, updates as Partial<Pick<typeof DEFAULT_USER_SETTINGS, "locale" | "numberFormat" | "dateFormat">>);
    const responseHeaders = new Headers({ "Content-Type": "application/json" });
    if (hasLocale) {
      responseHeaders.set("Set-Cookie", `locale=${result.locale}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    }
    return new Response(JSON.stringify(result), { headers: responseHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "api", action: "error", route: "/api/user-settings", method: "PUT", error: message });
    return new Response("Database update failed", { status: 500 });
  }
};
