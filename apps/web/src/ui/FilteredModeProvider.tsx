"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { DEMO_BUDGET_ADJUSTMENTS_COOKIE } from "@/lib/demoCookies";
import type { AutoFilterDelayMinutes } from "@/lib/locale";
import {
  getAutoFilterDelayMs,
  parseStoredLastActiveAt,
  resolveAutoFilterSettlementFailureTimerDecision,
  resolveManualModeTimerDecision,
  resolvePolicyChangeTimerDecision,
  resolveStoredVisibilityMode,
  resolveVisibleTimerDecision,
  type TimerDecision,
  type VisibilityMode,
} from "@/ui/filteredModeState";
import {
  createModeTransitionCoordinator,
  type ApplicationMode,
  type ModeTransitionRequest,
} from "@/ui/modeTransitionCoordinator";
import { useTableEditorTransition } from "@/ui/tables/shared/TableEditorActivationProvider";

type FilteredModeContextValue = Readonly<{
  visibilityMode: VisibilityMode;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  modeTransitionPending: boolean;
  requestModeTransition: (mode: ApplicationMode) => Promise<boolean>;
  resumePendingModeTransition: () => Promise<boolean> | null;
  updateAutoFilterDelayMinutes: (autoFilterDelayMinutes: AutoFilterDelayMinutes) => void;
  allowedCategories: ReadonlySet<string>;
  effectiveAllowlist: ReadonlySet<string> | null;
  allCategories: ReadonlyArray<string>;
  categoriesLoading: boolean;
}>;

const STORAGE_MODE_KEY = "expense-tracker-visibility-mode";
const STORAGE_LAST_ACTIVE_KEY = "expense-tracker-last-active-ts";

const FilteredModeContext = createContext<FilteredModeContextValue | null>(null);

type ProviderProps = Readonly<{
  isDemoMode: boolean;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  children: ReactNode;
}>;

export const FilteredModeProvider = (props: ProviderProps): ReactElement => {
  const { isDemoMode, autoFilterDelayMinutes: initialAutoFilterDelayMinutes, children } = props;
  const { requestEditorTransition } = useTableEditorTransition();

  const initialVisibilityMode: VisibilityMode = isDemoMode ? "all" : "filtered";
  const [visibilityMode, setVisibilityModeState] = useState<VisibilityMode>(initialVisibilityMode);
  const [autoFilterDelayMinutes, setAutoFilterDelayMinutesState] = useState<AutoFilterDelayMinutes>(
    initialAutoFilterDelayMinutes,
  );
  const [modeTransitionPending, setModeTransitionPending] = useState<boolean>(false);
  const visibilityModeRef = useRef<VisibilityMode>(initialVisibilityMode);
  const autoFilterDelayMinutesRef = useRef<AutoFilterDelayMinutes>(initialAutoFilterDelayMinutes);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerGenerationRef = useRef<number>(0);
  const requestModeTransitionRef = useRef<
    (request: ModeTransitionRequest) => Promise<boolean>
  >((_request): Promise<boolean> => Promise.reject(
    new Error("Mode transition coordinator is not initialized"),
  ));

  const setVisibilityModeAndRef = useCallback((mode: VisibilityMode): void => {
    visibilityModeRef.current = mode;
    setVisibilityModeState(mode);
  }, []);

  const [allowedCategories, setAllowedCategories] = useState<ReadonlySet<string>>(new Set());
  const [allCategories, setAllCategories] = useState<ReadonlyArray<string>>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);

  const clearInactivityTimer = useCallback((): void => {
    if (inactivityTimerRef.current !== null) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    timerGenerationRef.current += 1;
  }, []);

  const armInactivityTimer = useCallback((delayMs: number): void => {
    clearInactivityTimer();
    const timerGeneration = timerGenerationRef.current + 1;
    timerGenerationRef.current = timerGeneration;
    inactivityTimerRef.current = setTimeout(() => {
      if (timerGenerationRef.current !== timerGeneration) {
        return;
      }

      inactivityTimerRef.current = null;
      const decision = resolveVisibleTimerDecision({
        autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
        visibilityMode: visibilityModeRef.current,
        lastActiveAt: parseStoredLastActiveAt(localStorage.getItem(STORAGE_LAST_ACTIVE_KEY)),
        nowMs: Date.now(),
      });

      if (decision.kind === "switchToFiltered") {
        void requestModeTransitionRef.current({
          target: "filtered",
          source: "automatic",
        });
        return;
      }

      if (decision.kind === "arm") {
        armInactivityTimer(decision.delayMs);
      }
    }, delayMs);
  }, [clearInactivityTimer]);

  const applyTimerDecision = useCallback((decision: TimerDecision): void => {
    if (decision.kind === "cancel") {
      clearInactivityTimer();
      return;
    }

    if (decision.kind === "switchToFiltered") {
      void requestModeTransitionRef.current({
        target: "filtered",
        source: "automatic",
      });
      return;
    }

    localStorage.setItem(STORAGE_LAST_ACTIVE_KEY, String(decision.lastActiveAt));
    armInactivityTimer(decision.delayMs);
  }, [armInactivityTimer, clearInactivityTimer]);

  // Restore saved mode from validated localStorage after hydration.
  useEffect(() => {
    if (isDemoMode) return;

    const nowMs = Date.now();
    const restoredMode = resolveStoredVisibilityMode({
      storedMode: localStorage.getItem(STORAGE_MODE_KEY),
      storedLastActiveAt: localStorage.getItem(STORAGE_LAST_ACTIVE_KEY),
      autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
      nowMs,
    });
    setVisibilityModeAndRef(restoredMode);
    localStorage.setItem(STORAGE_MODE_KEY, restoredMode);

    const decision = resolveVisibleTimerDecision({
      autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
      visibilityMode: restoredMode,
      lastActiveAt: parseStoredLastActiveAt(localStorage.getItem(STORAGE_LAST_ACTIVE_KEY)),
      nowMs,
    });
    applyTimerDecision(decision);
  }, [applyTimerDecision, isDemoMode, setVisibilityModeAndRef]);

  useEffect(() => {
    fetch("/api/categories")
      .then((res) => {
        if (!res.ok) throw new Error(`Categories API: ${res.status}`);
        return res.json() as Promise<{ categories: ReadonlyArray<string> }>;
      })
      .then((data) => setAllCategories(data.categories))
      .catch((err: unknown) => console.error("Failed to fetch categories:", err));
  }, []);

  useEffect(() => {
    fetch("/api/workspace-settings")
      .then((res) => {
        if (!res.ok) throw new Error(`Workspace settings API: ${res.status}`);
        return res.json() as Promise<{ filteredCategories: ReadonlyArray<string> | null }>;
      })
      .then((data) => {
        if (data.filteredCategories !== null) {
          setAllowedCategories(new Set(data.filteredCategories));
        }
      })
      .catch((err: unknown) => console.error("Failed to fetch filtered categories:", err))
      .finally(() => setCategoriesLoading(false));
  }, []);

  const commitVisibilityMode = useCallback((mode: VisibilityMode): void => {
    const decision = resolveManualModeTimerDecision({
      autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
      visibilityMode: mode,
      nowMs: Date.now(),
    });
    setVisibilityModeAndRef(mode);
    localStorage.setItem(STORAGE_MODE_KEY, mode);
    applyTimerDecision(decision);
  }, [applyTimerDecision, setVisibilityModeAndRef]);

  const commitModeTransition = useCallback((
    request: ModeTransitionRequest,
  ): void => {
    if (request.target === "demo") {
      document.cookie = "demo=true; path=/; max-age=31536000";
      window.location.reload();
      return;
    }

    if (isDemoMode) {
      localStorage.setItem(STORAGE_MODE_KEY, request.target);
      document.cookie = "demo=; path=/; max-age=0";
      document.cookie = `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=; path=/; max-age=0`;
      window.location.reload();
      return;
    }

    commitVisibilityMode(request.target);
  }, [commitVisibilityMode, isDemoMode]);

  const handleModeSettlementFailure = useCallback((
    request: ModeTransitionRequest,
  ): void => {
    if (request.source !== "automatic") return;
    applyTimerDecision(resolveAutoFilterSettlementFailureTimerDecision({
      autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
      visibilityMode: visibilityModeRef.current,
      nowMs: Date.now(),
    }));
  }, [applyTimerDecision]);

  const handleModeSettlementError = useCallback((
    request: ModeTransitionRequest,
    error: unknown,
  ): void => {
    handleModeSettlementFailure(request);
    console.error(
      `${request.source} mode transition to "${request.target}" failed during editor settlement:`,
      error,
    );
  }, [handleModeSettlementFailure]);

  const modeTransitionCoordinator = useMemo(
    () => createModeTransitionCoordinator({
      settleEditors: requestEditorTransition,
      commitTransition: commitModeTransition,
      handleSettlementFailure: handleModeSettlementFailure,
      handleSettlementError: handleModeSettlementError,
    }),
    [
      commitModeTransition,
      handleModeSettlementError,
      handleModeSettlementFailure,
      requestEditorTransition,
    ],
  );
  const requestTransition = useCallback((
    request: ModeTransitionRequest,
  ): Promise<boolean> => {
    setModeTransitionPending(true);
    return modeTransitionCoordinator.requestTransition(request)
      .finally((): void => {
        setModeTransitionPending(false);
      });
  }, [modeTransitionCoordinator]);
  requestModeTransitionRef.current = requestTransition;

  const requestModeTransition = useCallback((
    target: ApplicationMode,
  ): Promise<boolean> => requestTransition({
    target,
    source: "manual",
  }), [requestTransition]);

  const resumePendingModeTransition = useCallback(
    (): Promise<boolean> | null => {
      const transition = modeTransitionCoordinator.retryPendingTransition();
      if (transition === null) return null;
      setModeTransitionPending(true);
      return transition.finally((): void => {
        setModeTransitionPending(false);
      });
    },
    [modeTransitionCoordinator],
  );

  const updateAutoFilterDelayMinutes = useCallback((nextAutoFilterDelayMinutes: AutoFilterDelayMinutes): void => {
    setAutoFilterDelayMinutesState(nextAutoFilterDelayMinutes);
    autoFilterDelayMinutesRef.current = nextAutoFilterDelayMinutes;

    if (isDemoMode) {
      clearInactivityTimer();
      return;
    }

    const decision = resolvePolicyChangeTimerDecision({
      autoFilterDelayMinutes: nextAutoFilterDelayMinutes,
      visibilityMode: visibilityModeRef.current,
      nowMs: Date.now(),
    });
    applyTimerDecision(decision);
  }, [applyTimerDecision, clearInactivityTimer, isDemoMode]);

  useEffect(() => {
    if (isDemoMode) {
      clearInactivityTimer();
      return;
    }

    const resetInactivityTimer = (): void => {
      if (document.hidden) return;
      if (autoFilterDelayMinutesRef.current === null) return;
      if (visibilityModeRef.current !== "all") return;

      const lastActiveAt = Date.now();
      localStorage.setItem(STORAGE_LAST_ACTIVE_KEY, String(lastActiveAt));
      armInactivityTimer(getAutoFilterDelayMs(autoFilterDelayMinutesRef.current));
    };

    const handleVisibilityChange = (): void => {
      if (autoFilterDelayMinutesRef.current === null) return;

      if (document.hidden) {
        if (visibilityModeRef.current === "all") {
          localStorage.setItem(STORAGE_LAST_ACTIVE_KEY, String(Date.now()));
        }
        clearInactivityTimer();
        return;
      }

      const decision = resolveVisibleTimerDecision({
        autoFilterDelayMinutes: autoFilterDelayMinutesRef.current,
        visibilityMode: visibilityModeRef.current,
        lastActiveAt: parseStoredLastActiveAt(localStorage.getItem(STORAGE_LAST_ACTIVE_KEY)),
        nowMs: Date.now(),
      });
      applyTimerDecision(decision);
    };

    const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "scroll"] as const;

    document.addEventListener("visibilitychange", handleVisibilityChange);
    ACTIVITY_EVENTS.forEach((evt) =>
      document.addEventListener(evt, resetInactivityTimer, { passive: true }),
    );

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      ACTIVITY_EVENTS.forEach((evt) => document.removeEventListener(evt, resetInactivityTimer));
      clearInactivityTimer();
    };
  }, [applyTimerDecision, armInactivityTimer, clearInactivityTimer, isDemoMode]);

  const effectiveAllowlist: ReadonlySet<string> | null =
    !isDemoMode && visibilityMode === "filtered" ? allowedCategories : null;

  const value: FilteredModeContextValue = {
    visibilityMode: isDemoMode ? "all" : visibilityMode,
    autoFilterDelayMinutes,
    modeTransitionPending,
    requestModeTransition,
    resumePendingModeTransition,
    updateAutoFilterDelayMinutes,
    allowedCategories,
    effectiveAllowlist,
    allCategories,
    categoriesLoading,
  };

  return (
    <FilteredModeContext.Provider value={value}>
      {children}
    </FilteredModeContext.Provider>
  );
};

export const useFilteredMode = (): FilteredModeContextValue => {
  const ctx = useContext(FilteredModeContext);
  if (ctx === null) {
    throw new Error("useFilteredMode must be used within a FilteredModeProvider");
  }
  return ctx;
};
