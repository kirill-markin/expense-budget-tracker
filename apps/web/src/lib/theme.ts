export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: ReadonlyArray<ThemePreference> = ["system", "light", "dark"];

/** Pre-account storage of the preference, read once to adopt it into the account. */
export const THEME_STORAGE_KEY = "expense-tracker-theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const parseThemePreference = (value: string | null): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemIsDark: boolean,
): ResolvedTheme => preference === "system" ? (systemIsDark ? "dark" : "light") : preference;

// Run in the document head before content paints, for the "system" preference
// only: an explicit one is already rendered as the <html> data-theme attribute.
export const SYSTEM_THEME_INIT_SCRIPT = `(() => {
  document.documentElement.dataset.theme = window.matchMedia(${JSON.stringify(THEME_MEDIA_QUERY)}).matches
    ? "dark"
    : "light";
})();`;
