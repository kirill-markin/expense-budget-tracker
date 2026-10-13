"use client";

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  parseThemePreference,
  resolveTheme,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = Readonly<{
  preference: ThemePreference;
  ready: boolean;
  setPreference: (preference: ThemePreference) => void;
}>;

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider = (props: Readonly<{ children: ReactNode }>): ReactElement => {
  // Keep the server render and initial client render identical. The head script
  // applies the actual colors before hydration; this state controls the selector.
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [ready, setReady] = useState<boolean>(false);
  const preferenceRef = useRef<ThemePreference>("system");

  const applyPreference = useCallback((next: ThemePreference): void => {
    preferenceRef.current = next;
    setPreferenceState(next);
    document.documentElement.dataset.theme = resolveTheme(next, window.matchMedia(THEME_MEDIA_QUERY).matches);
  }, []);

  // Reapply before paint if a development Strict Mode remount clears the
  // attribute written by the head script, then enable the hydrated selector.
  useLayoutEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
      applyPreference(parseThemePreference(storage.getItem(THEME_STORAGE_KEY)));
    } catch {
      // Browser privacy settings may block storage. System mode remains usable.
      applyPreference("system");
    }

    const media = window.matchMedia(THEME_MEDIA_QUERY);
    const handleSystemChange = (event: MediaQueryListEvent): void => {
      if (preferenceRef.current === "system") {
        document.documentElement.dataset.theme = resolveTheme("system", event.matches);
      }
    };
    const handleStorageChange = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      if (storage !== null && event.storageArea !== storage) return;
      applyPreference(parseThemePreference(event.newValue));
    };

    media.addEventListener("change", handleSystemChange);
    window.addEventListener("storage", handleStorageChange);
    setReady(true);
    return () => {
      media.removeEventListener("change", handleSystemChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [applyPreference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    applyPreference(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Apply changes for this visit even when the browser cannot persist them.
    }
  }, [applyPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, ready, setPreference }),
    [preference, ready, setPreference],
  );

  return <ThemeContext value={value}>{props.children}</ThemeContext>;
};

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
