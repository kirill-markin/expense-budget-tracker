import { COUNTED_USERS_CTE, getExcludedEmails } from "@/server/countedUsers";
import { queryReport, type RawRow } from "@/server/db";

export const USERS_LIST_LIMIT = 1000;
export const USERS_LIST_ACTIVITY_WINDOW_DAYS = 60;

export type ActivitySurface = "web" | "api" | "mcp";

/** Why a person is left out of every counted report, or null when they are counted. */
export type ExcludedReason = "local" | "admin_or_excluded";

/** Days are UTC ISO dates (YYYY-MM-DD); window counts cover the activity window ending today. */
export type UsersListRow = Readonly<{
  userId: string;
  email: string;
  createdDay: string;
  firstOpenDay: string | null;
  lastOpenDay: string | null;
  openDaysInWindow: number;
  trackDaysInWindow: number;
  surfaces: ReadonlyArray<ActivitySurface>;
  excludedReason: ExcludedReason | null;
}>;

export type UsersList = Readonly<{
  totalCount: number;
  users: ReadonlyArray<UsersListRow>;
}>;

type ParsedRow = Readonly<{ totalCount: number; user: UsersListRow }>;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const ACTIVITY_SURFACES: ReadonlyArray<ActivitySurface> = ["web", "api", "mcp"];

// The reason reuses counted_users, so this list and every counted report agree on who is excluded.
// Days are formatted in SQL because pg turns DATE values into local-time Date objects.
const USERS_LIST_SQL = `WITH ${COUNTED_USERS_CTE},
open_stats AS (
  SELECT
    user_id,
    min(activity_date) AS first_open_day,
    max(activity_date) AS last_open_day,
    count(DISTINCT activity_date) FILTER (
      WHERE activity_date BETWEEN $2::date - ($3::int - 1) AND $2::date
    ) AS open_days_in_window,
    array_agg(DISTINCT surface ORDER BY surface) AS surfaces
  FROM analytics.user_open_days
  GROUP BY user_id
),
track_stats AS (
  SELECT user_id, count(*) AS track_days_in_window
  FROM analytics.user_track_days
  WHERE activity_date BETWEEN $2::date - ($3::int - 1) AND $2::date
  GROUP BY user_id
)
SELECT
  u.user_id,
  u.email,
  to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_day,
  to_char(o.first_open_day, 'YYYY-MM-DD') AS first_open_day,
  to_char(o.last_open_day, 'YYYY-MM-DD') AS last_open_day,
  COALESCE(o.open_days_in_window, 0)::int AS open_days_in_window,
  COALESCE(t.track_days_in_window, 0)::int AS track_days_in_window,
  COALESCE(o.surfaces, ARRAY[]::text[]) AS surfaces,
  CASE
    WHEN c.user_id IS NOT NULL THEN NULL
    WHEN u.user_id = 'local' THEN 'local'
    ELSE 'admin_or_excluded'
  END AS excluded_reason,
  count(*) OVER ()::int AS total_count
FROM public.users AS u
LEFT JOIN counted_users AS c ON c.user_id = u.user_id
LEFT JOIN open_stats AS o ON o.user_id = u.user_id
LEFT JOIN track_stats AS t ON t.user_id = u.user_id
ORDER BY o.last_open_day DESC NULLS LAST, u.created_at DESC, u.user_id
LIMIT $4::int`;

const malformed = (row: RawRow, column: string): Error =>
  new Error(`users_list row has a malformed ${column}: ${JSON.stringify(row)}`);

const requireString = (row: RawRow, column: string): string => {
  const value = row[column];
  if (typeof value !== "string" || value === "") throw malformed(row, column);
  return value;
};

const requireIsoDay = (row: RawRow, column: string): string => {
  const value = requireString(row, column);
  if (!ISO_DAY_PATTERN.test(value)) throw malformed(row, column);
  return value;
};

const requireNullableIsoDay = (row: RawRow, column: string): string | null =>
  row[column] === null ? null : requireIsoDay(row, column);

const requireCount = (row: RawRow, column: string): number => {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw malformed(row, column);
  return value;
};

const isSurface = (value: unknown): value is ActivitySurface =>
  ACTIVITY_SURFACES.some((surface: ActivitySurface): boolean => surface === value);

const requireSurfaces = (row: RawRow): ReadonlyArray<ActivitySurface> => {
  const value = row.surfaces;
  if (!Array.isArray(value)) throw malformed(row, "surfaces");
  return value.map((surface: unknown): ActivitySurface => {
    if (!isSurface(surface)) throw malformed(row, "surfaces");
    return surface;
  });
};

const requireExcludedReason = (row: RawRow): ExcludedReason | null => {
  const value = row.excluded_reason;
  if (value === null || value === "local" || value === "admin_or_excluded") return value;
  throw malformed(row, "excluded_reason");
};

const parseRow = (row: RawRow): ParsedRow => ({
  totalCount: requireCount(row, "total_count"),
  user: {
    userId: requireString(row, "user_id"),
    email: requireString(row, "email"),
    createdDay: requireIsoDay(row, "created_day"),
    firstOpenDay: requireNullableIsoDay(row, "first_open_day"),
    lastOpenDay: requireNullableIsoDay(row, "last_open_day"),
    openDaysInWindow: requireCount(row, "open_days_in_window"),
    trackDaysInWindow: requireCount(row, "track_days_in_window"),
    surfaces: requireSurfaces(row),
    excludedReason: requireExcludedReason(row),
  },
});

/** Every person, including excluded ones, most recently opened first; `today` is the UTC ISO day ending the window. */
export const loadUsersList = async (today: string): Promise<UsersList> => {
  if (!ISO_DAY_PATTERN.test(today)) {
    throw new Error(`loadUsersList expects today as a UTC ISO day (YYYY-MM-DD), got ${JSON.stringify(today)}`);
  }
  const rows = await queryReport(
    "users_list",
    USERS_LIST_SQL,
    [getExcludedEmails(), today, USERS_LIST_ACTIVITY_WINDOW_DAYS, USERS_LIST_LIMIT],
    parseRow,
  );
  // The window count repeats the same total on every row; no rows means no people.
  return {
    totalCount: rows.length === 0 ? 0 : rows[0].totalCount,
    users: rows.map((row: ParsedRow): UsersListRow => row.user),
  };
};
