import { type SupportedLocale, type NumberFormat, type DateFormat, type UserSettings, DEFAULT_USER_SETTINGS, resolveLocale, NUMBER_FORMATS, DATE_FORMATS } from "@/lib/locale";
import { queryAs } from "@/server/db";

type UserSettingsRow = Readonly<{
  locale: string;
  number_format: string;
  date_format: string;
}>;

const parseNumberFormat = (raw: string): NumberFormat => {
  if ((NUMBER_FORMATS as ReadonlyArray<string>).includes(raw)) {
    return raw as NumberFormat;
  }
  return DEFAULT_USER_SETTINGS.numberFormat;
};

const parseDateFormat = (raw: string): DateFormat => {
  if ((DATE_FORMATS as ReadonlyArray<string>).includes(raw)) {
    return raw as DateFormat;
  }
  return DEFAULT_USER_SETTINGS.dateFormat;
};

export const getUserSettings = async (userId: string, workspaceId: string): Promise<UserSettings> => {
  await ensureUserSettings(userId, workspaceId);
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT locale, number_format, date_format FROM user_settings WHERE user_id = $1",
    [userId],
  );
  if (result.rows.length === 0) {
    return DEFAULT_USER_SETTINGS;
  }
  const row = result.rows[0] as UserSettingsRow;
  return {
    locale: resolveLocale(row.locale),
    numberFormat: parseNumberFormat(row.number_format),
    dateFormat: parseDateFormat(row.date_format),
  };
};

export const updateUserSettings = async (
  userId: string,
  workspaceId: string,
  settings: Partial<Pick<UserSettings, "locale" | "numberFormat" | "dateFormat">>,
): Promise<UserSettings> => {
  await ensureUserSettings(userId, workspaceId);

  const setClauses: Array<string> = [];
  const params: Array<unknown> = [userId];
  let idx = 2;

  if (settings.locale !== undefined) {
    setClauses.push(`locale = $${idx}`);
    params.push(settings.locale);
    idx++;
  }
  if (settings.numberFormat !== undefined) {
    setClauses.push(`number_format = $${idx}`);
    params.push(settings.numberFormat);
    idx++;
  }
  if (settings.dateFormat !== undefined) {
    setClauses.push(`date_format = $${idx}`);
    params.push(settings.dateFormat);
    idx++;
  }

  if (setClauses.length === 0) {
    return getUserSettings(userId, workspaceId);
  }

  const result = await queryAs(
    userId,
    workspaceId,
    `UPDATE user_settings SET ${setClauses.join(", ")} WHERE user_id = $1 RETURNING locale, number_format, date_format`,
    params,
  );

  if (result.rows.length === 0) {
    throw new Error(`user_settings row missing for user ${userId}`);
  }

  const row = result.rows[0] as UserSettingsRow;
  return {
    locale: resolveLocale(row.locale),
    numberFormat: parseNumberFormat(row.number_format),
    dateFormat: parseDateFormat(row.date_format),
  };
};

import { getPool } from "@/server/db";

const provisionedUsers = new Set<string>();

const ensureUserSettings = async (userId: string, workspaceId: string): Promise<void> => {
  if (provisionedUsers.has(userId)) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query(
      "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    await client.query("COMMIT");
    provisionedUsers.add(userId);
  } catch (err) {
    await client.query("ROLLBACK");
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "23505") {
      provisionedUsers.add(userId);
      return;
    }
    throw err;
  } finally {
    client.release();
  }
};
