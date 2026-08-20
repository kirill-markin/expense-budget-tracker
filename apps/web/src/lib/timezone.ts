export const UTC_TIMEZONE = "UTC";
export const BROWSER_TIMEZONE_COOKIE = "browser_timezone";
export const INVALID_TIMEZONE_MESSAGE = "Invalid timezone. Expected UTC or supported IANA timezone";

const getIntlSupportedTimezones = (): ReadonlyArray<string> => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

/**
 * Shape of an IANA zone name: `/`-separated parts that each start with a letter.
 *
 * `Intl.DateTimeFormat` also accepts numeric UTC offsets such as `+05:30`, which
 * are not zone names, carry no DST rules, and are not read the same way by
 * Postgres, where a stored timezone is interpolated into `AT TIME ZONE` by the
 * public share SQL functions. Link names such as `US/Pacific` and sign-carrying
 * names such as `Etc/GMT+5` are IANA names and stay accepted.
 */
const IANA_TIMEZONE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)*$/u;

/**
 * True when the value is an IANA zone name the runtime can format dates in.
 *
 * Acceptance is asked of Intl instead of matching
 * `Intl.supportedValuesOf("timeZone")`, which lists one identifier per zone and
 * omits the alternate spellings such as `US/Pacific`, `Asia/Calcutta`, and
 * `Europe/Kiev` that browsers still report and every formatting path handles
 * correctly.
 */
export const isValidTimezone = (value: string): boolean => {
  const normalizedValue = value.trim();
  if (!IANA_TIMEZONE_NAME_PATTERN.test(normalizedValue)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedValue }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

export const parseTimezone = (value: string): string | null => {
  const normalizedValue = value.trim();
  return isValidTimezone(normalizedValue) ? normalizedValue : null;
};

export const listSupportedTimezones = (): ReadonlyArray<string> => {
  const timezones = new Set<string>([UTC_TIMEZONE]);
  for (const timezone of getIntlSupportedTimezones()) {
    timezones.add(timezone);
  }
  return Array.from(timezones);
};

const resolveCanonicalTimezone = (value: string): string => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return value;
  }
};

/**
 * Timezone choices for a picker, always containing the currently selected zone
 * exactly once.
 *
 * `listSupportedTimezones()` carries the identifiers this engine chooses to
 * list, so a stored link name such as `Asia/Calcutta` can match no choice and
 * leave the picker blank. When the engine agrees that a listed identifier and
 * the stored spelling name the same zone, the stored spelling takes that slot
 * rather than being added next to it.
 *
 * Both sides are compared in canonical form because alias handling in
 * `resolvedOptions().timeZone` is implementation-defined: engines may return the
 * supplied identifier unchanged, and the listed identifier may itself be a
 * legacy spelling. When an engine reports no relation between the two spellings,
 * the stored value is appended, which is the only way to keep it selectable.
 */
export const listTimezoneOptions = (selectedTimezone: string): ReadonlyArray<string> => {
  const supportedTimezones = listSupportedTimezones();
  if (supportedTimezones.includes(selectedTimezone)) {
    return supportedTimezones;
  }

  const canonicalTimezone = resolveCanonicalTimezone(selectedTimezone);
  const canonicalIndex = supportedTimezones.findIndex(
    (timezone): boolean => resolveCanonicalTimezone(timezone) === canonicalTimezone,
  );
  if (canonicalIndex === -1) {
    return [...supportedTimezones, selectedTimezone];
  }

  return supportedTimezones.map((timezone, index): string =>
    index === canonicalIndex ? selectedTimezone : timezone,
  );
};

/**
 * Browser timezone normalized to a valid IANA zone for server requests.
 *
 * Headless and hardened browsers can report a non-IANA value such as
 * `Etc/Unknown`, meaning the browser cannot name its zone at all. UTC is the
 * only value that can succeed for them, so it is used instead of failing.
 */
export const resolveBrowserTimezone = (): string => {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof candidate !== "string") {
    return UTC_TIMEZONE;
  }

  return parseTimezone(candidate) ?? UTC_TIMEZONE;
};
