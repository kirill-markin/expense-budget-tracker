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

export const isValidTimezone = (value: string): boolean => {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    return false;
  }
  if (normalizedValue === UTC_TIMEZONE) {
    return true;
  }

  const supportedTimezones = getIntlSupportedTimezones();
  if (supportedTimezones.length > 0) {
    return supportedTimezones.includes(normalizedValue);
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

export const resolveBrowserTimezone = (): string => {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof candidate !== "string") {
    throw new Error("Browser timezone is unavailable");
  }

  const timezone = parseTimezone(candidate);
  if (timezone === null) {
    throw new Error(`Browser timezone is invalid: ${candidate}`);
  }

  return timezone;
};
