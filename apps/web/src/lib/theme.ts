export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "expense-tracker-theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const parseThemePreference = (value: string | null): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemIsDark: boolean,
): ResolvedTheme => preference === "system" ? (systemIsDark ? "dark" : "light") : preference;

// Run in the document head before content paints, including when storage is blocked.
export const THEME_INIT_SCRIPT = `(() => {
  let preference = "system";
  try {
    const stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {}
  document.documentElement.dataset.theme = preference === "system"
    ? (window.matchMedia(${JSON.stringify(THEME_MEDIA_QUERY)}).matches ? "dark" : "light")
    : preference;
})();`;
