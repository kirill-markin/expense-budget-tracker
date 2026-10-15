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

import { fetchWithCsrf } from "@/lib/csrf";
import {
  resolveTheme,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = Readonly<{
  preference: ThemePreference;
  ready: boolean;
  error: string | null;
  setPreference: (preference: ThemePreference) => void;
}>;

const ThemeContext = createContext<ThemeContextValue | null>(null);

const readStoredPreference = (): string | null => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Browser privacy settings may block storage; there is nothing to adopt.
    return null;
  }
};

const removeStoredPreference = (): void => {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Browser privacy settings may block storage; nothing is stored to remove.
  }
};

/**
 * canPersist is false on the public share pages: an anonymous visitor has no
 * settings API to save a preference to.
 * canAdopt is true only when initialPreference came from `user_settings` and a
 * PUT can confirm a write there, so the legacy localStorage key is left
 * untouched on the share pages, in demo mode, and when the database was down.
 */
export const ThemeProvider = (props: Readonly<{
  initialPreference: ThemePreference;
  canPersist: boolean;
  canAdopt: boolean;
  children: ReactNode;
}>): ReactElement => {
  // The server resolved the preference and rendered the matching colors, so the
  // first client render must repeat it unchanged.
  const [preference, setPreferenceState] = useState<ThemePreference>(props.initialPreference);
  const [ready, setReady] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const preferenceRef = useRef<ThemePreference>(props.initialPreference);

  const applyPreference = useCallback((next: ThemePreference): void => {
    preferenceRef.current = next;
    setPreferenceState(next);
    document.documentElement.dataset.theme = resolveTheme(next, window.matchMedia(THEME_MEDIA_QUERY).matches);
  }, []);

  /** Resolves to true once the account holds the preference. */
  const persistPreference = useCallback(async (next: ThemePreference): Promise<boolean> => {
    setError(null);
    try {
      const response = await fetchWithCsrf("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
      if (!response.ok) {
        setError(await response.text());
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  // data-theme is also a React-controlled prop on <html>, so any root re-render
  // (router.refresh()) reconciles it back to the server value and can strip it.
  // Re-asserting the client truth on every provider render keeps this the single
  // writer after first paint; a layout effect runs after the whole mutation
  // phase, so it lands last whatever the commit order was.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(
      preferenceRef.current,
      window.matchMedia(THEME_MEDIA_QUERY).matches,
    );
  });

  // Enable the hydrated selector, and adopt a pre-account preference once.
  useLayoutEffect(() => {
    if (props.canAdopt) {
      const stored = readStoredPreference();
      // Both branches read the server-sent value, never preferenceRef, which
      // the adoption itself mutates: on a Strict Mode remount the second run
      // would otherwise take the removal branch while the first run's save is
      // still in flight.
      if (props.initialPreference === "system" && (stored === "light" || stored === "dark")) {
        applyPreference(stored);
        // The adoption runs once ever, so until the account holds the
        // preference the legacy key is its only copy: drop it only after the
        // save succeeded.
        void persistPreference(stored).then((saved: boolean): void => {
          if (saved) {
            removeStoredPreference();
          }
        });
      } else {
        // The account holds a preference of its own, so the legacy key is
        // obsolete.
        removeStoredPreference();
      }
    }

    const media = window.matchMedia(THEME_MEDIA_QUERY);
    const handleSystemChange = (event: MediaQueryListEvent): void => {
      if (preferenceRef.current === "system") {
        document.documentElement.dataset.theme = resolveTheme("system", event.matches);
      }
    };

    media.addEventListener("change", handleSystemChange);
    setReady(true);
    return () => {
      media.removeEventListener("change", handleSystemChange);
    };
  }, [applyPreference, persistPreference, props.canAdopt, props.initialPreference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    applyPreference(next);
    if (props.canPersist) {
      void persistPreference(next).then((saved: boolean): void => {
        // An explicit choice that reached the account supersedes the legacy
        // key, including the copy a failed adoption deliberately retained;
        // without this, picking `system` could never stick.
        if (saved && props.canAdopt) {
          removeStoredPreference();
        }
      });
    }
  }, [applyPreference, persistPreference, props.canPersist, props.canAdopt]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, ready, error, setPreference }),
    [preference, ready, error, setPreference],
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
