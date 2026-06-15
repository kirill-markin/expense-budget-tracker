import { offsetMonth } from "@/lib/monthUtils";
import { clampMonthWindow, PUBLIC_MONTHLY_SHARE_MAX_WINDOW_MONTHS } from "@/server/community/months";
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  type MonthlyCategoryShareAccessLevel,
  type MonthlyCategoryShareItem,
  type MonthlyCategoryShareSettings,
  type MonthlyCategoryShareSettingsPatch,
  type MonthlyCategoryShareSettingsResponse,
} from "@/server/community/monthlyCategoryShareTypes";
import { generateMonthlyCategoryShareToken } from "@/server/community/shareTokens";

type ShareRow = Readonly<{
  share_id: string;
  enabled: boolean;
  indexing_enabled: boolean;
  display_label: string;
  month_from: Date | string | null;
  month_to: Date | string | null;
  blocked_at: Date | string | null;
  public_token: string | null;
}>;

type ShareItemRow = Readonly<{
  direction: string;
  category: string;
  access_level: string;
}>;

type CategoryRow = Readonly<{
  category: string;
}>;

export class MonthlyCategoryShareRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MonthlyCategoryShareRequestError";
  }
}

const MONTH_DATE_PATTERN = /^(\d{4})-(\d{2})-01$/u;
const TOKEN_INSERT_ATTEMPTS = 3;

const createDefaultSettings = (): MonthlyCategoryShareSettings => ({
  enabled: false,
  indexingEnabled: false,
  displayLabel: "",
  monthFrom: null,
  monthTo: null,
});

const formatDateAsMonth = (value: Date | string | null, fieldName: string): string | null => {
  if (value === null) return null;

  if (value instanceof Date) {
    const year = String(value.getUTCFullYear()).padStart(4, "0");
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  const dateOnly = value.slice(0, 10);
  if (!MONTH_DATE_PATTERN.test(dateOnly)) {
    throw new Error(`Invalid ${fieldName} stored for monthly category share: ${value}`);
  }
  return dateOnly.slice(0, 7);
};

const toDateParameter = (month: string | null): string | null =>
  month === null ? null : `${month}-01`;

const requireDisplayLabelPatchValue = (value: string | undefined): string => {
  if (value === undefined) {
    throw new Error("Monthly category share patch has hasDisplayLabel=true without displayLabel");
  }
  return value;
};

const requireMonthPatchValue = (value: string | null | undefined, fieldName: string): string | null => {
  if (value === undefined) {
    throw new Error(`Monthly category share patch has ${fieldName} flag without ${fieldName}`);
  }
  return value;
};

const parseAccessLevel = (raw: string): MonthlyCategoryShareAccessLevel => {
  if (raw === "category_only" || raw === "monthly_values") {
    return raw;
  }
  throw new Error(`Invalid monthly category share access level stored: ${raw}`);
};

const mapShareSettings = (share: ShareRow | null): MonthlyCategoryShareSettings => {
  if (share === null) return createDefaultSettings();
  return {
    enabled: share.enabled,
    indexingEnabled: share.indexing_enabled,
    displayLabel: share.display_label,
    monthFrom: formatDateAsMonth(share.month_from, "month_from"),
    monthTo: formatDateAsMonth(share.month_to, "month_to"),
  };
};

const mapItem = (row: ShareItemRow): MonthlyCategoryShareItem => {
  if (row.direction !== "spend") {
    throw new Error(`Invalid V1 monthly category share direction stored: ${row.direction}`);
  }
  return {
    direction: "spend",
    category: row.category,
    accessLevel: parseAccessLevel(row.access_level),
  };
};

const buildDashboardUrl = (appOrigin: string, publicToken: string): string =>
  `${appOrigin}/share/monthly/${encodeURIComponent(publicToken)}`;

const getJsonUrlMonthTo = (settings: MonthlyCategoryShareSettings): string | null => {
  if (settings.monthFrom === null) return null;
  const requestedMonthTo = settings.monthTo ?? offsetMonth(settings.monthFrom, PUBLIC_MONTHLY_SHARE_MAX_WINDOW_MONTHS - 1);
  return clampMonthWindow(
    settings.monthFrom,
    requestedMonthTo,
    PUBLIC_MONTHLY_SHARE_MAX_WINDOW_MONTHS,
  ).monthTo;
};

const buildMonthlyCategoryShareJsonUrl = (
  appOrigin: string,
  publicToken: string | null,
  settings: MonthlyCategoryShareSettings,
): string | null => {
  const monthTo = getJsonUrlMonthTo(settings);
  if (publicToken === null || settings.monthFrom === null || monthTo === null) return null;

  const url = new URL(`${appOrigin}/api/share/monthly/${encodeURIComponent(publicToken)}`);
  url.searchParams.set("monthFrom", settings.monthFrom);
  url.searchParams.set("monthTo", monthTo);
  return url.toString();
};

const buildResponse = (
  share: ShareRow | null,
  selectedItems: ReadonlyArray<MonthlyCategoryShareItem>,
  availableSpendCategories: ReadonlyArray<string>,
  appOrigin: string,
): MonthlyCategoryShareSettingsResponse => {
  const settings = mapShareSettings(share);
  const publicToken = share?.public_token ?? null;

  return {
    settings,
    dashboardUrl: publicToken === null ? null : buildDashboardUrl(appOrigin, publicToken),
    jsonUrl: buildMonthlyCategoryShareJsonUrl(appOrigin, publicToken, settings),
    selectedItems,
    availableSpendCategories,
  };
};

const getShareByWorkspace = async (queryFn: QueryFn, workspaceId: string): Promise<ShareRow | null> => {
  const result = await queryFn(
    `
      SELECT
        share.share_id,
        share.enabled,
        share.indexing_enabled,
        share.display_label,
        share.month_from,
        share.month_to,
        share.blocked_at,
        key.public_token
      FROM community.monthly_category_shares AS share
      LEFT JOIN community.monthly_category_share_keys AS key
        ON key.share_id = share.share_id
       AND key.revoked_at IS NULL
      WHERE share.workspace_id = $1
    `,
    [workspaceId],
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as ShareRow;
};

const getLockedShareByWorkspace = async (queryFn: QueryFn, workspaceId: string): Promise<ShareRow | null> => {
  const result = await queryFn(
    `
      SELECT share_id
      FROM community.monthly_category_shares
      WHERE workspace_id = $1
      FOR UPDATE
    `,
    [workspaceId],
  );
  if (result.rows.length === 0) return null;
  return getShareByWorkspace(queryFn, workspaceId);
};

const ensureShareByWorkspace = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ShareRow> => {
  await queryFn(
    `
      INSERT INTO community.monthly_category_shares (workspace_id, created_by_user_id)
      VALUES ($1, $2)
      ON CONFLICT (workspace_id) DO UPDATE
      SET updated_at = community.monthly_category_shares.updated_at
    `,
    [workspaceId, userId],
  );
  const share = await getShareByWorkspace(queryFn, workspaceId);
  if (share === null) {
    throw new Error(`Failed to create monthly category share for workspace ${workspaceId}`);
  }
  return share;
};

const getActiveTokenByShareId = async (queryFn: QueryFn, shareId: string): Promise<string | null> => {
  const result = await queryFn(
    `
      SELECT public_token
      FROM community.monthly_category_share_keys
      WHERE share_id = $1
        AND revoked_at IS NULL
    `,
    [shareId],
  );
  const row = result.rows[0] as { public_token: string } | undefined;
  return row === undefined ? null : row.public_token;
};

const listShareItems = async (
  queryFn: QueryFn,
  shareId: string,
): Promise<ReadonlyArray<MonthlyCategoryShareItem>> => {
  const result = await queryFn(
    `
      SELECT direction, category, access_level
      FROM community.monthly_category_share_items
      WHERE share_id = $1
        AND direction = 'spend'
      ORDER BY category
    `,
    [shareId],
  );
  return result.rows.map((row: ShareItemRow): MonthlyCategoryShareItem => mapItem(row));
};

const listAvailableSpendCategories = async (queryFn: QueryFn): Promise<ReadonlyArray<string>> => {
  const result = await queryFn(
    `
      SELECT DISTINCT category
      FROM ledger_entries
      WHERE kind = 'spend'
        AND category IS NOT NULL
        AND category <> ''
      ORDER BY category
    `,
    [],
  );
  return result.rows.map((row: CategoryRow): string => row.category);
};

const readResponse = async (
  queryFn: QueryFn,
  share: ShareRow | null,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> => {
  const selectedItems = share === null ? [] : await listShareItems(queryFn, share.share_id);
  const availableSpendCategories = await listAvailableSpendCategories(queryFn);
  return buildResponse(share, selectedItems, availableSpendCategories, appOrigin);
};

const assertUpdateRange = (share: ShareRow, params: MonthlyCategoryShareSettingsPatch): void => {
  const currentSettings = mapShareSettings(share);
  const monthFrom = params.hasMonthFrom
    ? requireMonthPatchValue(params.monthFrom, "monthFrom")
    : currentSettings.monthFrom;
  const monthTo = params.hasMonthTo
    ? requireMonthPatchValue(params.monthTo, "monthTo")
    : currentSettings.monthTo;

  if (monthFrom !== null && monthTo !== null && monthTo < monthFrom) {
    throw new MonthlyCategoryShareRequestError("monthTo must be the same as or after monthFrom");
  }

  if (share.enabled && monthFrom === null) {
    throw new MonthlyCategoryShareRequestError("monthFrom is required while public sharing is enabled");
  }
};

const updateShareSettingsRow = async (
  queryFn: QueryFn,
  share: ShareRow,
  workspaceId: string,
  params: MonthlyCategoryShareSettingsPatch,
): Promise<ShareRow> => {
  const setClauses: Array<string> = [];
  const values: Array<unknown> = [share.share_id];

  if (params.hasDisplayLabel) {
    values.push(requireDisplayLabelPatchValue(params.displayLabel));
    setClauses.push(`display_label = $${values.length}`);
  }
  if (params.hasMonthFrom) {
    values.push(toDateParameter(requireMonthPatchValue(params.monthFrom, "monthFrom")));
    setClauses.push(`month_from = $${values.length}::date`);
  }
  if (params.hasMonthTo) {
    values.push(toDateParameter(requireMonthPatchValue(params.monthTo, "monthTo")));
    setClauses.push(`month_to = $${values.length}::date`);
  }

  if (setClauses.length === 0) {
    throw new Error("Monthly category share settings update called without fields");
  }

  setClauses.push("updated_at = now()");

  await queryFn(
    `
      UPDATE community.monthly_category_shares
      SET ${setClauses.join(", ")}
      WHERE share_id = $1
    `,
    values,
  );

  const updated = await getShareByWorkspace(queryFn, workspaceId);
  if (updated === null) {
    throw new Error(`Monthly category share missing after settings update: shareId=${share.share_id}`);
  }
  return updated;
};

const assertItemsAreValid = (
  selectedItems: ReadonlyArray<MonthlyCategoryShareItem>,
  availableSpendCategories: ReadonlyArray<string>,
): void => {
  const available = new Set<string>(availableSpendCategories);
  const seen = new Set<string>();

  for (const item of selectedItems) {
    if (item.direction !== "spend") {
      throw new MonthlyCategoryShareRequestError("Only spend categories can be shared in V1");
    }
    if (seen.has(item.category)) {
      throw new MonthlyCategoryShareRequestError(`Duplicate monthly category share item: ${item.category}`);
    }
    seen.add(item.category);
    if (!available.has(item.category)) {
      throw new MonthlyCategoryShareRequestError(`Category is not available as a spend category: ${item.category}`);
    }
  }
};

const replaceShareItems = async (
  queryFn: QueryFn,
  shareId: string,
  selectedItems: ReadonlyArray<MonthlyCategoryShareItem>,
): Promise<void> => {
  await queryFn(
    "DELETE FROM community.monthly_category_share_items WHERE share_id = $1",
    [shareId],
  );

  if (selectedItems.length > 0) {
    await queryFn(
      `
        INSERT INTO community.monthly_category_share_items (
          share_id,
          direction,
          category,
          access_level
        )
        SELECT $1, item.direction, item.category, item.access_level
        FROM unnest($2::text[], $3::text[], $4::text[]) AS item(direction, category, access_level)
      `,
      [
        shareId,
        selectedItems.map((item: MonthlyCategoryShareItem): string => item.direction),
        selectedItems.map((item: MonthlyCategoryShareItem): string => item.category),
        selectedItems.map((item: MonthlyCategoryShareItem): string => item.accessLevel),
      ],
    );
  }

  await queryFn(
    "UPDATE community.monthly_category_shares SET updated_at = now() WHERE share_id = $1",
    [shareId],
  );
};

const ensureActiveToken = async (
  queryFn: QueryFn,
  share: ShareRow,
  createToken: () => string,
): Promise<string> => {
  if (share.public_token !== null) {
    return share.public_token;
  }

  for (let attempt = 1; attempt <= TOKEN_INSERT_ATTEMPTS; attempt++) {
    const result = await queryFn(
      `
        INSERT INTO community.monthly_category_share_keys (share_id, public_token)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        RETURNING public_token
      `,
      [share.share_id, createToken()],
    );
    const row = result.rows[0] as { public_token: string } | undefined;
    if (row !== undefined) {
      return row.public_token;
    }
    const activeToken = await getActiveTokenByShareId(queryFn, share.share_id);
    if (activeToken !== null) {
      return activeToken;
    }
  }

  throw new Error(`Failed to create unique monthly category share token: shareId=${share.share_id}`);
};

export const getMonthlyCategoryShareSettings = async (
  userId: string,
  workspaceId: string,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await getShareByWorkspace(queryFn, workspaceId);
    return readResponse(queryFn, share, appOrigin);
  });

export const updateMonthlyCategoryShareSettings = async (
  userId: string,
  workspaceId: string,
  params: MonthlyCategoryShareSettingsPatch,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await ensureShareByWorkspace(queryFn, userId, workspaceId);
    assertUpdateRange(share, params);
    const updated = await updateShareSettingsRow(queryFn, share, workspaceId, params);
    return readResponse(queryFn, updated, appOrigin);
  });

export const replaceMonthlyCategoryShareItems = async (
  userId: string,
  workspaceId: string,
  selectedItems: ReadonlyArray<MonthlyCategoryShareItem>,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await ensureShareByWorkspace(queryFn, userId, workspaceId);
    const availableSpendCategories = await listAvailableSpendCategories(queryFn);
    assertItemsAreValid(selectedItems, availableSpendCategories);
    await replaceShareItems(queryFn, share.share_id, selectedItems);
    const updated = await getShareByWorkspace(queryFn, workspaceId);
    if (updated === null) {
      throw new Error(`Monthly category share missing after item replacement: shareId=${share.share_id}`);
    }
    return buildResponse(updated, selectedItems, availableSpendCategories, appOrigin);
  });

export const enableMonthlyCategoryShare = async (
  userId: string,
  workspaceId: string,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await getLockedShareByWorkspace(queryFn, workspaceId);
    if (share === null || share.month_from === null) {
      throw new MonthlyCategoryShareRequestError("monthFrom is required before enabling public sharing");
    }

    await ensureActiveToken(queryFn, share, generateMonthlyCategoryShareToken);
    await queryFn(
      "UPDATE community.monthly_category_shares SET enabled = true, updated_at = now() WHERE share_id = $1",
      [share.share_id],
    );
    const updated = await getShareByWorkspace(queryFn, workspaceId);
    if (updated === null) {
      throw new Error(`Monthly category share missing after enable: shareId=${share.share_id}`);
    }
    return readResponse(queryFn, updated, appOrigin);
  });

export const disableMonthlyCategoryShare = async (
  userId: string,
  workspaceId: string,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await getShareByWorkspace(queryFn, workspaceId);
    if (share === null) {
      return readResponse(queryFn, null, appOrigin);
    }

    await queryFn(
      `
        UPDATE community.monthly_category_shares
        SET enabled = false,
            indexing_enabled = false,
            updated_at = now()
        WHERE share_id = $1
      `,
      [share.share_id],
    );
    const updated = await getShareByWorkspace(queryFn, workspaceId);
    if (updated === null) {
      throw new Error(`Monthly category share missing after disable: shareId=${share.share_id}`);
    }
    return readResponse(queryFn, updated, appOrigin);
  });

export const updateMonthlyCategoryShareIndexing = async (
  userId: string,
  workspaceId: string,
  indexingEnabled: boolean,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const share = await getShareByWorkspace(queryFn, workspaceId);
    if (share === null) {
      if (indexingEnabled) {
        throw new MonthlyCategoryShareRequestError("Public sharing must be enabled before search indexing can be enabled");
      }
      return readResponse(queryFn, null, appOrigin);
    }

    if (indexingEnabled && !share.enabled) {
      throw new MonthlyCategoryShareRequestError("Public sharing must be enabled before search indexing can be enabled");
    }

    await queryFn(
      `
        UPDATE community.monthly_category_shares
        SET indexing_enabled = $2,
            updated_at = now()
        WHERE share_id = $1
      `,
      [share.share_id, indexingEnabled],
    );
    const updated = await getShareByWorkspace(queryFn, workspaceId);
    if (updated === null) {
      throw new Error(`Monthly category share missing after indexing update: shareId=${share.share_id}`);
    }
    return readResponse(queryFn, updated, appOrigin);
  });

export const rotateMonthlyCategoryShareToken = async (
  userId: string,
  workspaceId: string,
  appOrigin: string,
): Promise<MonthlyCategoryShareSettingsResponse> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    await ensureShareByWorkspace(queryFn, userId, workspaceId);
    const share = await getLockedShareByWorkspace(queryFn, workspaceId);
    if (share === null) {
      throw new Error(`Failed to lock monthly category share for token rotation: workspaceId=${workspaceId}`);
    }
    await queryFn(
      `
        UPDATE community.monthly_category_share_keys
        SET revoked_at = now()
        WHERE share_id = $1
          AND revoked_at IS NULL
      `,
      [share.share_id],
    );
    await ensureActiveToken(
      queryFn,
      { ...share, public_token: null },
      generateMonthlyCategoryShareToken,
    );
    const updated = await getShareByWorkspace(queryFn, workspaceId);
    if (updated === null) {
      throw new Error(`Monthly category share missing after token rotation: shareId=${share.share_id}`);
    }
    return readResponse(queryFn, updated, appOrigin);
  });
