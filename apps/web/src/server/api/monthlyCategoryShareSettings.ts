import { z } from "zod";

import type { SupportedLocale } from "@/lib/locale";
import { getLocaleFromRequest } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { createBadRequestError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import {
  disableMonthlyCategoryShare,
  enableMonthlyCategoryShare,
  getMonthlyCategoryShareSettings,
  MonthlyCategoryShareRequestError,
  replaceMonthlyCategoryShareItems,
  rotateMonthlyCategoryShareToken,
  updateMonthlyCategoryShareIndexing,
  updateMonthlyCategoryShareSettings,
} from "@/server/community/monthlyCategoryShares";
import type {
  MonthlyCategoryShareIndexingUpdate,
  MonthlyCategoryShareItem,
  MonthlyCategoryShareSettingsPatch,
  MonthlyCategoryShareSettingsResponse,
} from "@/server/community/monthlyCategoryShareTypes";
import { getUserSettings } from "@/server/userSettings";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type JsonObject = Readonly<Record<string, unknown>>;

type MonthlyCategoryShareRouteContext = Readonly<{
  userId: string;
  workspaceId: string;
  appOrigin: string;
  initialLocale: SupportedLocale;
}>;

export type MonthlyCategoryShareRouteDependencies = Readonly<{
  getMonthlyCategoryShareSettings: typeof getMonthlyCategoryShareSettings;
  updateMonthlyCategoryShareSettings: typeof updateMonthlyCategoryShareSettings;
  replaceMonthlyCategoryShareItems: typeof replaceMonthlyCategoryShareItems;
  enableMonthlyCategoryShare: typeof enableMonthlyCategoryShare;
  disableMonthlyCategoryShare: typeof disableMonthlyCategoryShare;
  updateMonthlyCategoryShareIndexing: typeof updateMonthlyCategoryShareIndexing;
  rotateMonthlyCategoryShareToken: typeof rotateMonthlyCategoryShareToken;
  getUserSettings: typeof getUserSettings;
}>;

type ConfirmationPhraseBody = Readonly<{
  confirmationPhrase: string;
}>;

type IndexingBody = Readonly<{
  indexingEnabled: boolean;
  confirmationPhrase?: string;
}>;

const DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES: MonthlyCategoryShareRouteDependencies = {
  getMonthlyCategoryShareSettings,
  updateMonthlyCategoryShareSettings,
  replaceMonthlyCategoryShareItems,
  enableMonthlyCategoryShare,
  disableMonthlyCategoryShare,
  updateMonthlyCategoryShareIndexing,
  rotateMonthlyCategoryShareToken,
  getUserSettings,
};

export { DEFAULT_MONTHLY_CATEGORY_SHARE_ROUTE_DEPENDENCIES };

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const DISPLAY_LABEL_MAX_LENGTH = 80;
const CATEGORY_MAX_LENGTH = 200;

const hasOwn = (input: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(input, key);

const assertJsonObject = (input: unknown, message: string): JsonObject => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createBadRequestError(message);
  }
  return input as JsonObject;
};

const parseDisplayLabel = (value: unknown): string => {
  if (typeof value !== "string") {
    throw createBadRequestError("displayLabel must be a string");
  }
  if (value.length > DISPLAY_LABEL_MAX_LENGTH) {
    throw createBadRequestError("displayLabel must be 80 characters or fewer");
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw createBadRequestError("displayLabel must be plain text without control characters");
  }
  return value;
};

const parseNullableMonth = (value: unknown, fieldName: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !MONTH_PATTERN.test(value)) {
    throw createBadRequestError(`${fieldName} must be null or a month in YYYY-MM format`);
  }
  return value;
};

export const parseMonthlyCategoryShareSettingsBody = (
  input: unknown,
): MonthlyCategoryShareSettingsPatch => {
  const body = assertJsonObject(input, "Invalid monthly category share settings request body");
  const hasDisplayLabel = hasOwn(body, "displayLabel");
  const hasMonthFrom = hasOwn(body, "monthFrom");
  const hasMonthTo = hasOwn(body, "monthTo");

  if (!hasDisplayLabel && !hasMonthFrom && !hasMonthTo) {
    throw createBadRequestError("No fields to update");
  }

  const displayLabel = hasDisplayLabel ? parseDisplayLabel(body.displayLabel) : undefined;
  const monthFrom = hasMonthFrom ? parseNullableMonth(body.monthFrom, "monthFrom") : undefined;
  const monthTo = hasMonthTo ? parseNullableMonth(body.monthTo, "monthTo") : undefined;

  if (monthFrom !== undefined && monthTo !== undefined && monthFrom !== null && monthTo !== null && monthTo < monthFrom) {
    throw createBadRequestError("monthTo must be the same as or after monthFrom");
  }

  return {
    displayLabel,
    monthFrom,
    monthTo,
    hasDisplayLabel,
    hasMonthFrom,
    hasMonthTo,
  };
};

const parseCategory = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > CATEGORY_MAX_LENGTH) {
    throw createBadRequestError("items[].category must be a non-empty string of 200 characters or fewer");
  }
  return value;
};

const parseItem = (input: unknown): MonthlyCategoryShareItem => {
  const item = assertJsonObject(input, "items[] must be an object");
  if (item.direction !== "spend") {
    throw createBadRequestError("items[].direction must be 'spend'");
  }
  if (item.accessLevel !== "category_only" && item.accessLevel !== "monthly_values") {
    throw createBadRequestError("items[].accessLevel must be 'category_only' or 'monthly_values'");
  }
  return {
    direction: "spend",
    category: parseCategory(item.category),
    accessLevel: item.accessLevel,
  };
};

export const parseMonthlyCategoryShareItemsBody = (
  input: unknown,
): ReadonlyArray<MonthlyCategoryShareItem> => {
  const body = assertJsonObject(input, "Invalid monthly category share items request body");
  if (!Array.isArray(body.items)) {
    throw createBadRequestError("items must be an array");
  }

  const seenCategories = new Set<string>();
  const selectedItems = body.items.map((item: unknown): MonthlyCategoryShareItem => {
    const parsed = parseItem(item);
    if (seenCategories.has(parsed.category)) {
      throw createBadRequestError(`Duplicate monthly category share item: ${parsed.category}`);
    }
    seenCategories.add(parsed.category);
    return parsed;
  });

  return selectedItems;
};

const parseConfirmationPhraseBody = (input: unknown): ConfirmationPhraseBody => {
  const body = assertJsonObject(input, "Invalid monthly category share confirmation request body");
  if (typeof body.confirmationPhrase !== "string") {
    throw createBadRequestError("confirmationPhrase must be a string");
  }
  return { confirmationPhrase: body.confirmationPhrase };
};

const parseIndexingBody = (input: unknown): IndexingBody => {
  const body = assertJsonObject(input, "Invalid monthly category share indexing request body");
  if (typeof body.indexingEnabled !== "boolean") {
    throw createBadRequestError("indexingEnabled must be a boolean");
  }
  if (hasOwn(body, "confirmationPhrase") && typeof body.confirmationPhrase !== "string") {
    throw createBadRequestError("confirmationPhrase must be a string");
  }
  if (body.indexingEnabled && typeof body.confirmationPhrase !== "string") {
    throw createBadRequestError("confirmationPhrase is required when enabling search indexing");
  }
  return {
    indexingEnabled: body.indexingEnabled,
    confirmationPhrase: typeof body.confirmationPhrase === "string" ? body.confirmationPhrase : undefined,
  };
};

const assertConfirmationPhrase = (
  locale: SupportedLocale,
  translationKey: string,
  confirmationPhrase: string,
): void => {
  if (confirmationPhrase !== t(locale, translationKey)) {
    throw createBadRequestError("Confirmation phrase does not match");
  }
};

const getAppOrigin = (request: Request): string => {
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";
  if (configuredOrigin !== "") {
    return new URL(configuredOrigin).origin;
  }
  return new URL(request.url).origin;
};

const extractRouteContext = (request: Request): MonthlyCategoryShareRouteContext => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
  appOrigin: getAppOrigin(request),
  initialLocale: getLocaleFromRequest(request),
});

const getAuthenticatedUserLocale = async (
  context: MonthlyCategoryShareRouteContext,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<SupportedLocale> => {
  const settings = await dependencies.getUserSettings(
    context.userId,
    context.workspaceId,
    context.initialLocale,
  );
  return settings.locale;
};

const handleMonthlyCategoryShareRoute = async (
  route: string,
  method: string,
  internalErrorMessage: string,
  run: () => Promise<Response>,
): Promise<Response> =>
  handleRoute(
    { route, method, internalErrorMessage },
    async (): Promise<Response> => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof MonthlyCategoryShareRequestError) {
          throw createBadRequestError(error.message);
        }
        throw error;
      }
    },
  );

export const getMonthlyCategoryShareSettingsRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share",
    "GET",
    "Monthly category share settings query failed",
    async (): Promise<Response> => {
      const context = extractRouteContext(request);
      const result = await dependencies.getMonthlyCategoryShareSettings(
        context.userId,
        context.workspaceId,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const putMonthlyCategoryShareSettingsRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share",
    "PUT",
    "Monthly category share settings update failed",
    async (): Promise<Response> => {
      const params = parseMonthlyCategoryShareSettingsBody(await parseJsonBody(request, z.unknown()));
      const context = extractRouteContext(request);
      const result = await dependencies.updateMonthlyCategoryShareSettings(
        context.userId,
        context.workspaceId,
        params,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const putMonthlyCategoryShareItemsRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share/items",
    "PUT",
    "Monthly category share items update failed",
    async (): Promise<Response> => {
      const selectedItems = parseMonthlyCategoryShareItemsBody(await parseJsonBody(request, z.unknown()));
      const context = extractRouteContext(request);
      const result = await dependencies.replaceMonthlyCategoryShareItems(
        context.userId,
        context.workspaceId,
        selectedItems,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const postEnableMonthlyCategoryShareRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share/enable",
    "POST",
    "Monthly category share enable failed",
    async (): Promise<Response> => {
      const body = parseConfirmationPhraseBody(await parseJsonBody(request, z.unknown()));
      const context = extractRouteContext(request);
      const locale = await getAuthenticatedUserLocale(context, dependencies);
      assertConfirmationPhrase(locale, "publicShare.confirmPublicLinkPhrase", body.confirmationPhrase);
      const result = await dependencies.enableMonthlyCategoryShare(
        context.userId,
        context.workspaceId,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const postDisableMonthlyCategoryShareRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share/disable",
    "POST",
    "Monthly category share disable failed",
    async (): Promise<Response> => {
      const context = extractRouteContext(request);
      const result = await dependencies.disableMonthlyCategoryShare(
        context.userId,
        context.workspaceId,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const putMonthlyCategoryShareIndexingRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share/indexing",
    "PUT",
    "Monthly category share indexing update failed",
    async (): Promise<Response> => {
      const body = parseIndexingBody(await parseJsonBody(request, z.unknown()));
      const context = extractRouteContext(request);
      if (body.indexingEnabled) {
        if (body.confirmationPhrase === undefined) {
          throw new Error("Indexing confirmation phrase missing after request validation");
        }
        const locale = await getAuthenticatedUserLocale(context, dependencies);
        assertConfirmationPhrase(
          locale,
          "publicShare.confirmSearchIndexingPhrase",
          body.confirmationPhrase,
        );
      }
      const params: MonthlyCategoryShareIndexingUpdate = { indexingEnabled: body.indexingEnabled };
      const result = await dependencies.updateMonthlyCategoryShareIndexing(
        context.userId,
        context.workspaceId,
        params.indexingEnabled,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export const postRotateMonthlyCategoryShareTokenRouteWithDeps = async (
  request: Request,
  dependencies: MonthlyCategoryShareRouteDependencies,
): Promise<Response> =>
  handleMonthlyCategoryShareRoute(
    "/api/community/monthly-category-share/rotate-token",
    "POST",
    "Monthly category share token rotation failed",
    async (): Promise<Response> => {
      const context = extractRouteContext(request);
      const result = await dependencies.rotateMonthlyCategoryShareToken(
        context.userId,
        context.workspaceId,
        context.appOrigin,
      );
      return Response.json(result);
    },
  );

export type { MonthlyCategoryShareSettingsResponse };
