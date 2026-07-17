import {
  type SupportedLocale,
  type NumberFormat,
  type DateFormat,
  type UserSettings,
  type AutoFilterDelayMinutes,
  type EnabledAutoFilterDelayMinutes,
  DEFAULT_USER_SETTINGS,
  resolveLocale,
  NUMBER_FORMATS,
  DATE_FORMATS,
  AUTO_FILTER_DELAY_MINUTES,
} from "@/lib/locale";
import { queryAs } from "@/server/db";

type UserSettingsRow = Readonly<{
  locale: string;
  number_format: string;
  date_format: string;
  auto_filter_delay_minutes: unknown;
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

const parseAutoFilterDelayMinutes = (raw: unknown): AutoFilterDelayMinutes => {
  if (raw === null) {
    return null;
  }
  if (typeof raw === "number" && (AUTO_FILTER_DELAY_MINUTES as ReadonlyArray<number>).includes(raw)) {
    return raw as EnabledAutoFilterDelayMinutes;
  }
  throw new Error(`Unexpected user_settings.auto_filter_delay_minutes value ${String(raw)}. Expected one of: ${AUTO_FILTER_DELAY_MINUTES.join(", ")} or null`);
};

export const getUserSettings = async (userId: string, workspaceId: string, initialLocale: SupportedLocale): Promise<UserSettings> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT locale, number_format, date_format, auto_filter_delay_minutes FROM user_settings WHERE user_id = $1",
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
    autoFilterDelayMinutes: parseAutoFilterDelayMinutes(row.auto_filter_delay_minutes),
  };
};

export const updateUserSettings = async (
  userId: string,
  workspaceId: string,
  settings: Partial<Pick<UserSettings, "locale" | "numberFormat" | "dateFormat" | "autoFilterDelayMinutes">>,
  initialLocale: SupportedLocale,
): Promise<UserSettings> => {
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
  if (settings.autoFilterDelayMinutes !== undefined) {
    setClauses.push(`auto_filter_delay_minutes = $${idx}`);
    params.push(settings.autoFilterDelayMinutes);
    idx++;
  }

  if (setClauses.length === 0) {
    return getUserSettings(userId, workspaceId, initialLocale);
  }

  const result = await queryAs(
    userId,
    workspaceId,
    `UPDATE user_settings SET ${setClauses.join(", ")} WHERE user_id = $1 RETURNING locale, number_format, date_format, auto_filter_delay_minutes`,
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
    autoFilterDelayMinutes: parseAutoFilterDelayMinutes(row.auto_filter_delay_minutes),
  };
};
