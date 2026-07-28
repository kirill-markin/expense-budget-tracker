"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import {
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useTranslation } from "react-i18next";

import {
  getMainContentInvalidationSourceId,
  publishMainContentInvalidation,
} from "../session/invalidation/mainContentInvalidationChannel";
import {
  buildChatTargetUrl,
  clearChatSelection,
  getChatActiveDraftStorageKey,
  getChatSelectionStorageKey,
  parseStoredChatTarget,
  readChatActiveDraftId,
  readChatSelection,
  readChatSessionTargetFromSearchParams,
  writeChatActiveDraftId,
  writeChatSelection,
  type ChatSelectionScope,
} from "./chatSelectionStorage";
import {
  fetchChatSessionSummaryPage,
  type ChatSessionSummary,
  type ChatSessionSummaryPage,
} from "./chatSessionSummaryTransport";
import {
  shouldPollChatSessionCatalog,
  shouldReevaluateChatActivityAfterVisibilityChange,
  type ChatPageVisibility,
} from "./chatActivityPolicy";
import {
  areChatTargetsEqual,
  appendChatSessionCatalogPage,
  createChatWorkspaceState,
  failChatSessionCatalogLoad,
  findChatSessionInvalidationIncrements,
  getChatTargetKey,
  getRunningChatSessionCount,
  observeChatSessionInvalidationVersion,
  replaceChatSessionCatalog,
  resolveAutomaticChatTarget,
  resolveAutomaticChatTargetAfterRefresh,
  resolveFailedSessionRecoveryTarget,
  resolveNewChatDraftTarget,
  selectChatWorkspaceTarget,
  startChatSessionCatalogLoad,
  type ChatSelectionReason,
  type ChatTarget,
  type ChatWorkspaceState,
} from "./chatWorkspaceState";

const CHAT_SESSION_CATALOG_LIMIT = 100;
const CHAT_SESSION_CATALOG_POLL_INTERVAL_MS = 10_000;

const getInitialChatPageVisibility = (): ChatPageVisibility =>
  typeof document === "undefined"
    ? "visible"
    : document.visibilityState;

type NavigationMode = "none" | "push" | "replace";

export type ChatWorkspaceInvalidationSource = "live" | "snapshot";

export type ChatDraftSessionAdoption =
  | Readonly<{
    kind: "selected";
    target: Extract<ChatTarget, { kind: "session" }>;
    selectionEpoch: number;
  }>
  | Readonly<{
    kind: "background";
    target: Extract<ChatTarget, { kind: "session" }>;
    draftStateDisposition: "transfer" | "preserve";
  }>;

export type ChatDraftSessionAdoptionPlan = Readonly<{
  draftId: string;
  sessionId: string;
  expectedSelectionEpoch: number;
  controllerTarget: ChatTarget;
  controllerSelectionEpoch: number;
  controllerActiveDraftId: string | null;
  shouldClearActiveDraft: boolean;
  shouldPersistSelection: boolean;
  adoption: ChatDraftSessionAdoption;
}>;

export type ChatDraftCreationPlan = Readonly<{
  kind: "reuse" | "transition";
  sourceTarget: ChatTarget;
  sourceSelectionReason: ChatSelectionReason;
  sourceSelectionEpoch: number;
  sourceActiveDraftId: string | null;
  target: Extract<ChatTarget, { kind: "draft" }>;
  selectionEpoch: number;
  shouldPersistActiveDraft: boolean;
  shouldPersistSelection: boolean;
  navigationMode: Extract<NavigationMode, "push" | "replace">;
}>;

type ChatDraftCreationInput =
  | Readonly<{
    kind: "reuse_selected_draft";
    currentState: ChatWorkspaceState;
    currentSelectionEpoch: number;
    currentActiveDraftId: string | null;
  }>
  | Readonly<{
    kind: "replace_selected_target";
    currentState: ChatWorkspaceState;
    currentSelectionEpoch: number;
    currentActiveDraftId: string | null;
    nextDraftId: string;
  }>;

type UseChatWorkspaceControllerParams = Readonly<{
  scope: ChatSelectionScope;
}>;

export const promoteSelectedChatWorkspaceTargetToExplicit = (
  state: ChatWorkspaceState,
  target: ChatTarget,
): ChatWorkspaceState => {
  if (!areChatTargetsEqual(state.target, target)) {
    throw new Error(
      `Cannot promote unselected chat target `
      + `"${getChatTargetKey(target)}" to explicit`,
    );
  }
  if (state.selectionReason === "explicit") {
    return state;
  }

  return {
    ...state,
    selectionReason: "explicit",
  };
};

export const resolveChatDraftCreationPlan = (
  input: ChatDraftCreationInput,
): ChatDraftCreationPlan => {
  const sourceTarget = input.currentState.target;
  if (input.kind === "reuse_selected_draft") {
    if (sourceTarget.kind !== "draft") {
      throw new Error(
        `Cannot reuse non-draft chat target "${getChatTargetKey(sourceTarget)}"`,
      );
    }
    const isAlreadyExplicit =
      input.currentState.selectionReason === "explicit";
    return {
      kind: isAlreadyExplicit ? "reuse" : "transition",
      sourceTarget,
      sourceSelectionReason: input.currentState.selectionReason,
      sourceSelectionEpoch: input.currentSelectionEpoch,
      sourceActiveDraftId: input.currentActiveDraftId,
      target: sourceTarget,
      selectionEpoch: isAlreadyExplicit
        ? input.currentSelectionEpoch
        : input.currentSelectionEpoch + 1,
      shouldPersistActiveDraft: !isAlreadyExplicit,
      shouldPersistSelection: !isAlreadyExplicit,
      navigationMode: "replace",
    };
  }

  const activeDraftIdForResolution =
    sourceTarget.kind === "draft"
    && input.currentActiveDraftId === sourceTarget.draftId
      ? null
      : input.currentActiveDraftId;
  const target = resolveNewChatDraftTarget(
    sourceTarget,
    activeDraftIdForResolution,
    false,
    input.nextDraftId,
  );
  if (target.kind !== "draft") {
    throw new Error("New chat draft resolution returned a server session");
  }
  return {
    kind: "transition",
    sourceTarget,
    sourceSelectionReason: input.currentState.selectionReason,
    sourceSelectionEpoch: input.currentSelectionEpoch,
    sourceActiveDraftId: input.currentActiveDraftId,
    target,
    selectionEpoch: input.currentSelectionEpoch + 1,
    shouldPersistActiveDraft: true,
    shouldPersistSelection: true,
    navigationMode: "push",
  };
};

export type ChatWorkspaceController = Readonly<{
  state: ChatWorkspaceState;
  selectionEpoch: number;
  isReady: boolean;
  historyOpen: boolean;
  historyErrorMessage: string | null;
  runningCount: number;
  setHistoryOpen: (open: boolean) => void;
  selectSession: (sessionId: string) => void;
  planSelectedDraftReuse: () => ChatDraftCreationPlan;
  planDraftReplacement: () => ChatDraftCreationPlan;
  commitDraftCreation: (plan: ChatDraftCreationPlan) => void;
  finalizeDraftCreation: (plan: ChatDraftCreationPlan) => void;
  promoteSelectedTargetToExplicit: (target: ChatTarget) => number;
  planDraftSessionAdoption: (
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ) => ChatDraftSessionAdoptionPlan;
  commitDraftSessionAdoption: (
    plan: ChatDraftSessionAdoptionPlan,
  ) => ChatDraftSessionAdoption;
  finalizeDraftSessionAdoption: (
    plan: ChatDraftSessionAdoptionPlan,
  ) => void;
  isSelectionCurrent: (
    target: ChatTarget,
    selectionEpoch: number,
  ) => boolean;
  refreshCatalog: () => Promise<void>;
  loadNextCatalogPage: () => Promise<void>;
  observeSessionInvalidation: (
    sessionId: string,
    version: number,
    source: ChatWorkspaceInvalidationSource,
  ) => void;
  recoverInvalidSessionSelection: (
    sessionId: string,
    errorMessage: string,
  ) => boolean;
}>;

const createDraftId = (): string => {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Browser crypto.randomUUID is unavailable for local chat drafts");
  }

  return `draft-${crypto.randomUUID()}`;
};

type ChatBootstrapSelectionInput = Readonly<{
  bootstrapSelectionEpoch: number;
  currentSelectionEpoch: number;
  currentTarget: ChatTarget;
  currentSelectionReason: ChatSelectionReason;
  urlTarget: ChatTarget | null;
  storedTarget: ChatTarget | null;
  automaticTarget: ChatTarget;
}>;

type ChatDraftSessionAdoptionInput = Readonly<{
  currentTarget: ChatTarget;
  currentSelectionEpoch: number;
  draftId: string;
  sessionId: string;
  expectedSelectionEpoch: number;
}>;

export const resolveChatDraftSessionAdoption = (
  input: ChatDraftSessionAdoptionInput,
): ChatDraftSessionAdoption => {
  const draftTarget = {
    kind: "draft",
    draftId: input.draftId,
  } as const;
  const sessionTarget = {
    kind: "session",
    sessionId: input.sessionId,
  } as const;
  const isSourceTargetSelected = areChatTargetsEqual(
    input.currentTarget,
    draftTarget,
  );
  if (
    isSourceTargetSelected
    && input.currentSelectionEpoch === input.expectedSelectionEpoch
  ) {
    return {
      kind: "selected",
      target: sessionTarget,
      selectionEpoch: input.currentSelectionEpoch,
    };
  }

  return {
    kind: "background",
    target: sessionTarget,
    draftStateDisposition: isSourceTargetSelected ? "preserve" : "transfer",
  };
};

export type ChatBootstrapSelection = Readonly<{
  target: ChatTarget;
  selectionReason: ChatSelectionReason;
  selectionChangedDuringBootstrap: boolean;
}>;

export const resolveChatBootstrapSelection = (
  input: ChatBootstrapSelectionInput,
): ChatBootstrapSelection => {
  if (input.currentSelectionEpoch !== input.bootstrapSelectionEpoch) {
    return {
      target: input.currentTarget,
      selectionReason: input.currentSelectionReason,
      selectionChangedDuringBootstrap: true,
    };
  }

  const target = input.urlTarget
    ?? input.storedTarget
    ?? input.automaticTarget;
  return {
    target,
    selectionReason:
      input.urlTarget !== null || input.storedTarget !== null
        ? "explicit"
        : "automatic",
    selectionChangedDuringBootstrap: false,
  };
};

type ChatBootstrapRecoveryInput = Readonly<{
  selection: ChatBootstrapSelection;
  hasUrlSessionParameter: boolean;
  urlSelectionFailed: boolean;
  storedTarget: ChatTarget | null;
  storedSelectionFailed: boolean;
  activeDraftFailed: boolean;
}>;

export type ChatBootstrapRecoveryDecision = Readonly<{
  showRecoveryNotice: boolean;
  shouldReplaceUrl: boolean;
}>;

export const resolveChatBootstrapRecovery = (
  input: ChatBootstrapRecoveryInput,
): ChatBootstrapRecoveryDecision => {
  if (input.selection.selectionChangedDuringBootstrap) {
    return {
      showRecoveryNotice: false,
      shouldReplaceUrl: false,
    };
  }
  if (input.hasUrlSessionParameter) {
    return input.urlSelectionFailed
      ? {
          showRecoveryNotice: true,
          shouldReplaceUrl: true,
        }
      : {
          showRecoveryNotice: false,
          shouldReplaceUrl: false,
        };
  }
  if (input.storedSelectionFailed) {
    return {
      showRecoveryNotice: true,
      shouldReplaceUrl: false,
    };
  }
  if (input.storedTarget !== null) {
    return {
      showRecoveryNotice: false,
      shouldReplaceUrl: false,
    };
  }

  return {
    showRecoveryNotice:
      input.activeDraftFailed && input.selection.target.kind === "draft",
    shouldReplaceUrl: false,
  };
};

type ChatUrlSynchronizationInput = Readonly<{
  previousPathname: string;
  pathname: string;
  controllerNavigationMatches: boolean;
  urlTarget: ChatTarget | null;
  currentTarget: ChatTarget;
  currentSelectionReason: ChatSelectionReason;
  activeDraftTarget: Extract<ChatTarget, { kind: "draft" }>;
}>;

export type ChatUrlSynchronizationDecision =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "navigate"; target: ChatTarget }>
  | Readonly<{ kind: "select"; target: ChatTarget }>;

export const resolveChatUrlSynchronization = (
  input: ChatUrlSynchronizationInput,
): ChatUrlSynchronizationDecision => {
  if (
    input.pathname !== "/chat"
    || input.controllerNavigationMatches
  ) {
    return { kind: "none" };
  }
  if (input.urlTarget !== null) {
    return (
      areChatTargetsEqual(input.currentTarget, input.urlTarget)
      && input.currentSelectionReason === "explicit"
    )
      ? { kind: "none" }
      : { kind: "select", target: input.urlTarget };
  }
  if (input.previousPathname === "/chat") {
    return (
      input.currentTarget.kind === "draft"
      && input.currentSelectionReason === "explicit"
      && areChatTargetsEqual(
        input.currentTarget,
        input.activeDraftTarget,
      )
    )
      ? { kind: "none" }
      : { kind: "select", target: input.activeDraftTarget };
  }
  if (
    input.currentTarget.kind === "session"
    && input.currentSelectionReason === "explicit"
  ) {
    return { kind: "navigate", target: input.currentTarget };
  }

  return { kind: "none" };
};

export const resolveChatHistoryErrorMessage = (
  catalogErrorMessage: string | null,
  recoveryNotice: string | null,
): string | null =>
  catalogErrorMessage ?? recoveryNotice;

export type ChatHistoryStatusVisibility = Readonly<{
  showEmpty: boolean;
  showLoading: boolean;
}>;

export const resolveChatHistoryStatusVisibility = (
  sessionCount: number,
  isLoading: boolean,
  hasLoadedFirstPage: boolean,
  errorMessage: string | null,
): ChatHistoryStatusVisibility => {
  if (!Number.isSafeInteger(sessionCount) || sessionCount < 0) {
    throw new Error(
      "Chat history session count must be a non-negative safe integer",
    );
  }

  return {
    showLoading: isLoading && sessionCount === 0,
    showEmpty:
      hasLoadedFirstPage
      && !isLoading
      && sessionCount === 0
      && errorMessage === null,
  };
};

export type ChatHistoryPaginationFocusTarget =
  | "none"
  | "load_more"
  | "create_draft";

export const resolveChatHistoryPaginationFocus = (
  loadMoreOwnsFocus: boolean,
  hasMore: boolean,
): ChatHistoryPaginationFocusTarget => {
  if (!loadMoreOwnsFocus) {
    return "none";
  }
  return hasMore ? "load_more" : "create_draft";
};

export const shouldReuseSelectedChatDraft = (
  isReady: boolean,
  currentTarget: ChatTarget,
  isSelectedDraftUntouched: boolean,
): boolean =>
  isReady
  && currentTarget.kind === "draft"
  && isSelectedDraftUntouched;

type PostReadyAutomaticCatalogSelectionInput = Readonly<{
  requestStartedReady: boolean;
  requestSelectionEpoch: number;
  requestSelectionReason: ChatSelectionReason;
  currentSelectionEpoch: number;
  currentSelectionReason: ChatSelectionReason;
  currentTarget: ChatTarget;
  summaries: ReadonlyArray<ChatSessionSummary>;
  unavailableSessionIds: ReadonlySet<string>;
  currentTimeMs: number;
  draftId: string;
}>;

export const resolvePostReadyAutomaticCatalogSelection = (
  input: PostReadyAutomaticCatalogSelectionInput,
): ChatTarget | null => {
  if (
    !input.requestStartedReady
    || input.requestSelectionReason !== "automatic"
    || input.currentSelectionEpoch !== input.requestSelectionEpoch
    || input.currentSelectionReason !== "automatic"
  ) {
    return null;
  }

  const target = resolveAutomaticChatTargetAfterRefresh(
    input.summaries.filter(
      (summary): boolean =>
        !input.unavailableSessionIds.has(summary.sessionId),
    ),
    input.currentTarget,
    input.currentTimeMs,
    input.draftId,
  );
  return areChatTargetsEqual(input.currentTarget, target) ? null : target;
};

export type InvalidChatUrlRecoveryDecision = Readonly<{
  target: ChatTarget;
  selectionReason: ChatSelectionReason;
  shouldClearStoredSelection: boolean;
}>;

export const resolveInvalidChatUrlRecovery = (
  storage: Storage,
  scope: ChatSelectionScope,
  summaries: ReadonlyArray<ChatSessionSummary>,
  currentTimeMs: number,
  draftId: string,
): InvalidChatUrlRecoveryDecision => {
  const storedValue = storage.getItem(getChatSelectionStorageKey(scope));
  if (storedValue === null) {
    return {
      target: resolveAutomaticChatTarget(
        summaries,
        currentTimeMs,
        draftId,
      ),
      selectionReason: "automatic",
      shouldClearStoredSelection: false,
    };
  }

  let storedTarget: ChatTarget | null;
  try {
    storedTarget = parseStoredChatTarget(storedValue);
  } catch {
    return {
      target: resolveAutomaticChatTarget(
        summaries,
        currentTimeMs,
        draftId,
      ),
      selectionReason: "automatic",
      shouldClearStoredSelection: true,
    };
  }
  return storedTarget === null
    ? {
      target: resolveAutomaticChatTarget(
        summaries,
        currentTimeMs,
        draftId,
      ),
      selectionReason: "automatic",
      shouldClearStoredSelection: false,
    }
    : {
      target: storedTarget,
      selectionReason: "explicit",
      shouldClearStoredSelection: false,
    };
};

export type ChatControllerNavigationOrigin = Readonly<{
  generation: number;
  url: string;
}>;

export type ChatControllerNavigation = Readonly<{
  generation: number;
  url: string;
  outstandingOrigins: ReadonlyArray<ChatControllerNavigationOrigin>;
}>;

export type ChatControllerNavigationWriteDecision =
  | Readonly<{
    kind: "none";
    controllerNavigation: ChatControllerNavigation | null;
  }>
  | Readonly<{
    kind: "navigate";
    navigationMode: Exclude<NavigationMode, "none">;
    generation: number;
    controllerNavigation: ChatControllerNavigation | null;
  }>;

export const resolveChatControllerNavigationWrite = (
  currentUrl: string,
  targetUrl: string,
  requestedNavigationMode: Exclude<NavigationMode, "none">,
  currentGeneration: number,
  controllerNavigation: ChatControllerNavigation | null,
): ChatControllerNavigationWriteDecision => {
  const activeControllerNavigation =
    controllerNavigation?.generation === currentGeneration
      ? controllerNavigation
      : null;
  if (
    activeControllerNavigation?.url === targetUrl
    || (
      activeControllerNavigation === null
      && currentUrl === targetUrl
    )
  ) {
    return {
      kind: "none",
      controllerNavigation: activeControllerNavigation,
    };
  }

  const nextGeneration = currentGeneration + 1;
  if (currentUrl === targetUrl) {
    return {
      kind: "navigate",
      navigationMode: "replace",
      generation: nextGeneration,
      controllerNavigation: null,
    };
  }

  const outstandingOrigins = activeControllerNavigation === null
    ? []
    : [
      ...activeControllerNavigation.outstandingOrigins,
      {
        generation: activeControllerNavigation.generation,
        url: activeControllerNavigation.url,
      },
    ].filter(
      (origin): boolean => origin.url !== targetUrl,
    );
  return {
    kind: "navigate",
    navigationMode: requestedNavigationMode,
    generation: nextGeneration,
    controllerNavigation: {
      generation: nextGeneration,
      url: targetUrl,
      outstandingOrigins,
    },
  };
};

export type ChatControllerNavigationObservation =
  | Readonly<{ kind: "external" }>
  | Readonly<{
    kind: "settle";
  }>
  | Readonly<{
    kind: "restore";
    url: string;
    controllerNavigation: ChatControllerNavigation;
  }>;

export const resolveChatControllerNavigationObservation = (
  controllerNavigation: ChatControllerNavigation | null,
  currentGeneration: number,
  currentUrl: string,
): ChatControllerNavigationObservation => {
  if (
    controllerNavigation === null
    || controllerNavigation.generation !== currentGeneration
  ) {
    return { kind: "external" };
  }
  if (controllerNavigation.url === currentUrl) {
    return { kind: "settle" };
  }
  const completedOrigin = controllerNavigation.outstandingOrigins.find(
    (origin): boolean => origin.url === currentUrl,
  );
  if (completedOrigin !== undefined) {
    return {
      kind: "restore",
      url: controllerNavigation.url,
      controllerNavigation: {
        ...controllerNavigation,
        outstandingOrigins:
          controllerNavigation.outstandingOrigins.filter(
            (origin): boolean =>
              origin.generation !== completedOrigin.generation,
          ),
      },
    };
  }
  return { kind: "external" };
};

export type ChatControllerNavigationRetirement = Readonly<{
  generation: number;
  controllerNavigation: null;
}>;

export const retireChatControllerNavigation = (
  currentGeneration: number,
): ChatControllerNavigationRetirement => ({
  generation: currentGeneration + 1,
  controllerNavigation: null,
});

export type ChatPopStateNavigation = ChatControllerNavigationRetirement &
  Readonly<{
    targetNavigationMode: "none" | null;
  }>;

export const resolveChatPopStateNavigation = (
  pathname: string,
  currentGeneration: number,
): ChatPopStateNavigation => ({
  ...retireChatControllerNavigation(currentGeneration),
  targetNavigationMode: pathname === "/chat" ? "none" : null,
});

export const useChatWorkspaceController = (
  params: UseChatWorkspaceControllerParams,
): ChatWorkspaceController => {
  const { scope } = params;
  const { t } = useTranslation();
  const workspaceId = scope.mode === "workspace" ? scope.workspaceId : "";
  const stableScope = useMemo<ChatSelectionScope>(
    () => scope.mode === "demo"
      ? { mode: "demo", userId: scope.userId }
      : {
        mode: "workspace",
        userId: scope.userId,
        workspaceId,
      },
    [scope.mode, scope.userId, workspaceId],
  );
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const translationRef = useRef(t);
  translationRef.current = t;
  const scopeKey = getChatSelectionStorageKey(stableScope);
  const initialTarget = { kind: "draft", draftId: "initializing" } as const;
  const [state, setState] = useState<ChatWorkspaceState>(
    createChatWorkspaceState(initialTarget, "automatic"),
  );
  const [selectionEpoch, setSelectionEpoch] = useState<number>(0);
  const [isReady, setIsReady] = useState<boolean>(false);
  const [historyOpen, setHistoryOpenState] = useState<boolean>(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [pageVisibility, setPageVisibility] = useState<ChatPageVisibility>(
    getInitialChatPageVisibility,
  );
  const stateRef = useRef<ChatWorkspaceState>(state);
  const selectionEpochRef = useRef<number>(selectionEpoch);
  const isReadyRef = useRef<boolean>(isReady);
  const activeDraftIdRef = useRef<string | null>(null);
  const unavailableSessionIdsRef = useRef<Set<string>>(new Set<string>());
  const hasRefreshedUnavailableSessionsRef = useRef<boolean>(false);
  const automaticCatalogRecoveryPendingRef = useRef<boolean>(false);
  const catalogRequestIdRef = useRef<number>(0);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const navigationGenerationRef = useRef<number>(0);
  const controllerNavigationRef =
    useRef<ChatControllerNavigation | null>(null);
  const invalidationSourceIdRef = useRef<string | null>(null);
  const lastInvalidationEmittedAtRef = useRef<number>(0);
  const observedUrlRef = useRef<string | null>(null);

  const commitState = useCallback((
    update: SetStateAction<ChatWorkspaceState>,
  ): ChatWorkspaceState => {
    const nextState = typeof update === "function"
      ? update(stateRef.current)
      : update;
    stateRef.current = nextState;
    setState(nextState);
    return nextState;
  }, []);

  const commitSelectionEpoch = useCallback((nextEpoch: number): void => {
    selectionEpochRef.current = nextEpoch;
    setSelectionEpoch(nextEpoch);
  }, []);

  const commitReady = useCallback((nextReady: boolean): void => {
    isReadyRef.current = nextReady;
    setIsReady(nextReady);
  }, []);

  const commitRecoveryNotice = useCallback((
    nextRecoveryNotice: string | null,
  ): void => {
    setRecoveryNotice(nextRecoveryNotice);
  }, []);

  const surfaceRecoveryNotice = useCallback((
    nextRecoveryNotice: string,
  ): void => {
    setRecoveryNotice(nextRecoveryNotice);
    setHistoryOpenState(true);
  }, []);

  const commitActiveDraftId = useCallback((
    draftId: string | null,
  ): void => {
    activeDraftIdRef.current = draftId;
    writeChatActiveDraftId(window.sessionStorage, stableScope, draftId);
  }, [stableScope]);

  const navigateToTarget = useCallback((
    target: ChatTarget,
    navigationMode: NavigationMode,
  ): void => {
    if (navigationMode === "none" || window.location.pathname !== "/chat") {
      return;
    }

    const url = buildChatTargetUrl(target);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const decision = resolveChatControllerNavigationWrite(
      currentUrl,
      url,
      navigationMode,
      navigationGenerationRef.current,
      controllerNavigationRef.current,
    );
    controllerNavigationRef.current = decision.controllerNavigation;
    if (decision.kind === "none") {
      return;
    }

    navigationGenerationRef.current = decision.generation;
    if (decision.navigationMode === "push") {
      router.push(url, { scroll: false });
      return;
    }

    router.replace(url, { scroll: false });
  }, [router]);

  const persistSelectedTarget = useCallback((
    target: ChatTarget,
    selectionReason: ChatSelectionReason,
  ): void => {
    if (selectionReason !== "explicit") {
      return;
    }

    writeChatSelection(window.sessionStorage, stableScope, target);
  }, [stableScope]);

  const selectTarget = useCallback((
    target: ChatTarget,
    selectionReason: ChatSelectionReason,
    navigationMode: NavigationMode,
  ): void => {
    const currentState = stateRef.current;
    if (
      areChatTargetsEqual(currentState.target, target)
      && currentState.selectionReason === selectionReason
    ) {
      if (navigationMode === "replace") {
        navigateToTarget(target, navigationMode);
      }
      return;
    }

    const nextEpoch = selectionEpochRef.current + 1;
    const nextState = selectChatWorkspaceTarget(
      currentState,
      target,
      selectionReason,
    );
    persistSelectedTarget(target, selectionReason);
    commitSelectionEpoch(nextEpoch);
    commitState(nextState);
    navigateToTarget(target, navigationMode);
  }, [
    commitSelectionEpoch,
    commitState,
    navigateToTarget,
    persistSelectedTarget,
  ]);

  const publishInvalidation = useCallback((
    version: number,
  ): void => {
    if (invalidationSourceIdRef.current === null) {
      invalidationSourceIdRef.current = getMainContentInvalidationSourceId();
    }
    const emittedAt = Math.max(
      Date.now(),
      lastInvalidationEmittedAtRef.current + 1,
    );
    lastInvalidationEmittedAtRef.current = emittedAt;

    publishMainContentInvalidation({
      workspaceId,
      version,
      sourceId: invalidationSourceIdRef.current,
      emittedAt,
    });
    if (window.location.pathname !== "/chat") {
      router.refresh();
    }
  }, [router, workspaceId]);

  const publishCatalogPageInvalidations = useCallback((
    currentState: ChatWorkspaceState,
    nextState: ChatWorkspaceState,
    page: ChatSessionSummaryPage,
  ): void => {
    const increments = findChatSessionInvalidationIncrements(
      currentState.mainContentInvalidationVersions,
      page.sessions,
    );
    commitState(nextState);
    for (const increment of increments) {
      publishInvalidation(increment.nextVersion);
    }
  }, [commitState, publishInvalidation]);

  const applyFirstCatalogPage = useCallback((
    page: ChatSessionSummaryPage,
  ): void => {
    const currentState = stateRef.current;
    publishCatalogPageInvalidations(
      currentState,
      replaceChatSessionCatalog(currentState, page),
      page,
    );
    if (unavailableSessionIdsRef.current.size > 0) {
      const catalogSessionIds = new Set(
        page.sessions.map((summary): string => summary.sessionId),
      );
      const remainingUnavailableSessionIds = new Set(
        [...unavailableSessionIdsRef.current].filter(
          (sessionId: string): boolean => catalogSessionIds.has(sessionId),
        ),
      );
      unavailableSessionIdsRef.current = remainingUnavailableSessionIds;
      if (remainingUnavailableSessionIds.size === 0) {
        hasRefreshedUnavailableSessionsRef.current = false;
      }
    }
  }, [publishCatalogPageInvalidations]);

  const applyNextCatalogPage = useCallback((
    page: ChatSessionSummaryPage,
  ): void => {
    const currentState = stateRef.current;
    publishCatalogPageInvalidations(
      currentState,
      appendChatSessionCatalogPage(currentState, page),
      page,
    );
  }, [publishCatalogPageInvalidations]);

  const loadCatalogPage = useCallback(async (): Promise<ChatSessionSummaryPage | null> => {
    if (stableScope.mode === "demo") {
      const page: ChatSessionSummaryPage = {
        sessions: [],
        nextCursor: null,
      };
      applyFirstCatalogPage(page);
      return page;
    }

    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    catalogAbortRef.current?.abort();
    const abortController = new AbortController();
    catalogAbortRef.current = abortController;
    commitState(startChatSessionCatalogLoad(stateRef.current));

    try {
      const page = await fetchChatSessionSummaryPage(
        CHAT_SESSION_CATALOG_LIMIT,
        null,
        abortController.signal,
      );
      if (
        abortController.signal.aborted
        || requestId !== catalogRequestIdRef.current
      ) {
        return null;
      }

      applyFirstCatalogPage(page);
      return page;
    } catch (error) {
      if (
        abortController.signal.aborted
        || requestId !== catalogRequestIdRef.current
      ) {
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      commitState(failChatSessionCatalogLoad(stateRef.current, message));
      return null;
    } finally {
      if (catalogAbortRef.current === abortController) {
        catalogAbortRef.current = null;
      }
    }
  }, [
    applyFirstCatalogPage,
    commitState,
    stableScope.mode,
  ]);

  const refreshCatalogAndReconcileAutomaticSelection = useCallback(
    async (): Promise<void> => {
      const requestStartedReady = isReadyRef.current;
      const requestSelectionEpoch = selectionEpochRef.current;
      const requestSelectionReason = stateRef.current.selectionReason;
      const page = await loadCatalogPage();
      if (page === null) {
        return;
      }

      const draftId = activeDraftIdRef.current ?? createDraftId();
      const target = resolvePostReadyAutomaticCatalogSelection({
        requestStartedReady,
        requestSelectionEpoch,
        requestSelectionReason,
        currentSelectionEpoch: selectionEpochRef.current,
        currentSelectionReason: stateRef.current.selectionReason,
        currentTarget: stateRef.current.target,
        summaries: page.sessions,
        unavailableSessionIds: unavailableSessionIdsRef.current,
        currentTimeMs: Date.now(),
        draftId,
      });
      automaticCatalogRecoveryPendingRef.current = false;
      if (target === null) {
        return;
      }
      if (
        activeDraftIdRef.current === null
        || target.kind === "draft"
      ) {
        commitActiveDraftId(draftId);
      }
      selectTarget(target, "automatic", "replace");
    },
    [
      commitActiveDraftId,
      loadCatalogPage,
      selectTarget,
    ],
  );

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (automaticCatalogRecoveryPendingRef.current) {
      await refreshCatalogAndReconcileAutomaticSelection();
      return;
    }

    await loadCatalogPage();
  }, [
    loadCatalogPage,
    refreshCatalogAndReconcileAutomaticSelection,
  ]);

  const loadNextCatalogPage = useCallback(async (): Promise<void> => {
    if (stableScope.mode === "demo" || catalogAbortRef.current !== null) {
      return;
    }

    const nextCursor = stateRef.current.pagination.nextCursor;
    if (nextCursor === null) {
      return;
    }

    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    const abortController = new AbortController();
    catalogAbortRef.current = abortController;
    commitState(startChatSessionCatalogLoad(stateRef.current));

    try {
      const page = await fetchChatSessionSummaryPage(
        CHAT_SESSION_CATALOG_LIMIT,
        nextCursor,
        abortController.signal,
      );
      if (
        abortController.signal.aborted
        || requestId !== catalogRequestIdRef.current
      ) {
        return;
      }

      applyNextCatalogPage(page);
    } catch (error) {
      if (
        abortController.signal.aborted
        || requestId !== catalogRequestIdRef.current
      ) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      commitState(failChatSessionCatalogLoad(stateRef.current, message));
    } finally {
      if (catalogAbortRef.current === abortController) {
        catalogAbortRef.current = null;
      }
    }
  }, [
    applyNextCatalogPage,
    commitState,
    stableScope.mode,
  ]);

  const recoverToSafeTarget = useCallback((
    errorMessage: string,
    excludedSessionIds: ReadonlySet<string> | null,
  ): void => {
    const draftId = activeDraftIdRef.current ?? createDraftId();
    if (activeDraftIdRef.current === null) {
      commitActiveDraftId(draftId);
    }
    const safeTarget = excludedSessionIds === null
      ? resolveAutomaticChatTarget(
        stateRef.current.summaries,
        Date.now(),
        draftId,
      )
      : resolveFailedSessionRecoveryTarget(
        stateRef.current.summaries,
        excludedSessionIds,
        Date.now(),
        draftId,
      );
    if (safeTarget.kind === "draft") {
      commitActiveDraftId(safeTarget.draftId);
    }

    clearChatSelection(window.sessionStorage, stableScope);
    surfaceRecoveryNotice(errorMessage);
    selectTarget(safeTarget, "automatic", "replace");
  }, [
    commitActiveDraftId,
    selectTarget,
    stableScope,
    surfaceRecoveryNotice,
  ]);

  const recoverInvalidUrlSelection = useCallback((
    errorMessage: string,
  ): void => {
    const draftId = activeDraftIdRef.current ?? createDraftId();
    const decision = resolveInvalidChatUrlRecovery(
      window.sessionStorage,
      stableScope,
      stateRef.current.summaries,
      Date.now(),
      draftId,
    );
    if (decision.shouldClearStoredSelection) {
      clearChatSelection(window.sessionStorage, stableScope);
    }
    if (
      activeDraftIdRef.current === null
      || decision.target.kind === "draft"
    ) {
      commitActiveDraftId(
        decision.target.kind === "draft"
          ? decision.target.draftId
          : draftId,
      );
    }

    surfaceRecoveryNotice(errorMessage);
    selectTarget(
      decision.target,
      decision.selectionReason,
      "replace",
    );
  }, [
    commitActiveDraftId,
    selectTarget,
    stableScope,
    surfaceRecoveryNotice,
  ]);

  useEffect(() => {
    let isCurrentScope = true;
    catalogAbortRef.current?.abort();
    catalogRequestIdRef.current += 1;
    activeDraftIdRef.current = null;
    unavailableSessionIdsRef.current = new Set<string>();
    hasRefreshedUnavailableSessionsRef.current = false;
    automaticCatalogRecoveryPendingRef.current = false;
    controllerNavigationRef.current = null;
    commitReady(false);
    commitRecoveryNotice(null);
    commitSelectionEpoch(0);
    commitState(createChatWorkspaceState(initialTarget, "automatic"));

    void (async (): Promise<void> => {
      let storedTarget: ChatTarget | null = null;
      let storedActiveDraftId: string | null = null;
      let storedSelectionFailed = false;
      let activeDraftFailed = false;
      const bootstrapSelectionEpoch = selectionEpochRef.current;

      try {
        storedTarget = readChatSelection(window.sessionStorage, stableScope);
      } catch {
        storedSelectionFailed = true;
        clearChatSelection(window.sessionStorage, stableScope);
      }

      try {
        storedActiveDraftId = readChatActiveDraftId(
          window.sessionStorage,
          stableScope,
        );
      } catch {
        activeDraftFailed = true;
        writeChatActiveDraftId(window.sessionStorage, stableScope, null);
      }
      const draftId = storedActiveDraftId ?? createDraftId();
      commitActiveDraftId(draftId);

      const page = await loadCatalogPage();
      if (!isCurrentScope) {
        return;
      }

      const currentPathname = window.location.pathname;
      const currentSearchParams = new URLSearchParams(window.location.search);
      const hasUrlSessionParameter = currentPathname === "/chat"
        && currentSearchParams.has("session");
      let urlTarget: ChatTarget | null = null;
      let urlSelectionFailed = false;
      try {
        urlTarget = currentPathname === "/chat"
          ? readChatSessionTargetFromSearchParams(currentSearchParams)
          : null;
      } catch {
        urlSelectionFailed = true;
      }
      const bootstrapSelection = resolveChatBootstrapSelection({
        bootstrapSelectionEpoch,
        currentSelectionEpoch: selectionEpochRef.current,
        currentTarget: stateRef.current.target,
        currentSelectionReason: stateRef.current.selectionReason,
        urlTarget,
        storedTarget,
        automaticTarget: resolveAutomaticChatTarget(
          page?.sessions ?? [],
          Date.now(),
          draftId,
        ),
      });
      const bootstrapRecovery = resolveChatBootstrapRecovery({
        selection: bootstrapSelection,
        hasUrlSessionParameter,
        urlSelectionFailed,
        storedTarget,
        storedSelectionFailed,
        activeDraftFailed,
      });
      const { target, selectionReason: reason } = bootstrapSelection;
      if (target.kind === "draft") {
        commitActiveDraftId(target.draftId);
      }
      selectTarget(
        target,
        reason,
        bootstrapSelection.selectionChangedDuringBootstrap
          ? "none"
          : bootstrapRecovery.shouldReplaceUrl
          ? "replace"
          : urlTarget === null && reason === "explicit" ? "replace" : "none",
      );
      if (bootstrapRecovery.showRecoveryNotice) {
        surfaceRecoveryNotice(
          translationRef.current("chat.sessionUnavailable"),
        );
      }
      automaticCatalogRecoveryPendingRef.current =
        page === null
        && !bootstrapSelection.selectionChangedDuringBootstrap
        && reason === "automatic";
      commitReady(true);
    })();

    return () => {
      isCurrentScope = false;
      catalogAbortRef.current?.abort();
      catalogAbortRef.current = null;
    };
  }, [
    commitReady,
    commitActiveDraftId,
    commitSelectionEpoch,
    commitState,
    loadCatalogPage,
    scopeKey,
    stableScope,
    surfaceRecoveryNotice,
    selectTarget,
  ]);

  const runningCount = getRunningChatSessionCount(state.summaries);

  useEffect(() => {
    if (
      !isReady
      || !shouldPollChatSessionCatalog(
        runningCount,
        pageVisibility,
      )
    ) {
      return;
    }

    const intervalId = window.setInterval((): void => {
      if (
        catalogAbortRef.current !== null
        || !shouldPollChatSessionCatalog(
          runningCount,
          document.visibilityState,
        )
      ) {
        return;
      }
      void loadCatalogPage();
    }, CHAT_SESSION_CATALOG_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [
    isReady,
    loadCatalogPage,
    pageVisibility,
    runningCount,
  ]);

  useEffect(() => {
    let previousVisibility: ChatPageVisibility = document.visibilityState;
    setPageVisibility(previousVisibility);
    const handleVisibilityChange = (): void => {
      const nextVisibility: ChatPageVisibility = document.visibilityState;
      const shouldRefresh =
        shouldReevaluateChatActivityAfterVisibilityChange(
          previousVisibility,
          nextVisibility,
        );
      previousVisibility = nextVisibility;
      setPageVisibility(nextVisibility);
      if (!shouldRefresh || !isReadyRef.current) {
        return;
      }

      void refreshCatalogAndReconcileAutomaticSelection();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
  }, [refreshCatalogAndReconcileAutomaticSelection]);

  useEffect(() => {
    const handlePopState = (): void => {
      const popStateNavigation = resolveChatPopStateNavigation(
        window.location.pathname,
        navigationGenerationRef.current,
      );
      navigationGenerationRef.current = popStateNavigation.generation;
      controllerNavigationRef.current =
        popStateNavigation.controllerNavigation;
      if (popStateNavigation.targetNavigationMode === null) {
        return;
      }

      try {
        const urlTarget = readChatSessionTargetFromSearchParams(
          new URLSearchParams(window.location.search),
        );
        if (urlTarget !== null) {
          selectTarget(
            urlTarget,
            "explicit",
            popStateNavigation.targetNavigationMode,
          );
          return;
        }

        const draftId = activeDraftIdRef.current ?? createDraftId();
        commitActiveDraftId(draftId);
        selectTarget(
          { kind: "draft", draftId },
          "explicit",
          popStateNavigation.targetNavigationMode,
        );
      } catch {
        recoverInvalidUrlSelection(
          translationRef.current("chat.sessionUnavailable"),
        );
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [commitActiveDraftId, recoverInvalidUrlSelection, selectTarget]);

  useEffect(() => {
    const currentUrl = searchParamsString === ""
      ? pathname
      : `${pathname}?${searchParamsString}`;
    const previousUrl = observedUrlRef.current;
    observedUrlRef.current = currentUrl;
    const controllerNavigation = controllerNavigationRef.current;
    const controllerNavigationObservation =
      resolveChatControllerNavigationObservation(
        controllerNavigation,
        navigationGenerationRef.current,
        currentUrl,
      );
    if (controllerNavigationObservation.kind === "settle") {
      controllerNavigationRef.current = null;
      return;
    }
    if (controllerNavigationObservation.kind === "restore") {
      controllerNavigationRef.current =
        controllerNavigationObservation.controllerNavigation;
      router.replace(
        controllerNavigationObservation.url,
        { scroll: false },
      );
      return;
    }
    if (
      pathname !== "/chat"
      || previousUrl === null
      || previousUrl === currentUrl
    ) {
      if (pathname !== "/chat") {
        controllerNavigationRef.current = null;
      }
      return;
    }

    try {
      const urlTarget = readChatSessionTargetFromSearchParams(
        new URLSearchParams(searchParamsString),
      );
      const draftId = activeDraftIdRef.current ?? createDraftId();
      const activeDraftTarget = { kind: "draft", draftId } as const;
      const queryStart = previousUrl.indexOf("?");
      const previousPathname = queryStart === -1
        ? previousUrl
        : previousUrl.slice(0, queryStart);
      const currentState = stateRef.current;
      const decision = resolveChatUrlSynchronization({
        previousPathname,
        pathname,
        controllerNavigationMatches:
          controllerNavigationObservation.kind !== "external",
        urlTarget,
        currentTarget: currentState.target,
        currentSelectionReason: currentState.selectionReason,
        activeDraftTarget,
      });
      if (decision.kind === "navigate") {
        navigateToTarget(decision.target, "replace");
        return;
      }
      if (decision.kind === "select") {
        if (decision.target.kind === "draft") {
          commitActiveDraftId(decision.target.draftId);
        }
        selectTarget(decision.target, "explicit", "replace");
        return;
      }
      navigateToTarget(currentState.target, "replace");
    } catch {
      recoverInvalidUrlSelection(
        translationRef.current("chat.sessionUnavailable"),
      );
    }
  }, [
    commitActiveDraftId,
    navigateToTarget,
    pathname,
    recoverInvalidUrlSelection,
    router,
    searchParamsString,
    selectTarget,
  ]);

  const setHistoryOpen = useCallback((open: boolean): void => {
    setHistoryOpenState(open);
    if (!open) {
      commitRecoveryNotice(null);
    }
    if (open && isReadyRef.current) {
      void refreshCatalog();
    }
  }, [commitRecoveryNotice, refreshCatalog]);

  const selectSession = useCallback((sessionId: string): void => {
    selectTarget(
      { kind: "session", sessionId },
      "explicit",
      "push",
    );
    if (unavailableSessionIdsRef.current.has(sessionId)) {
      const nextUnavailableSessionIds = new Set(
        unavailableSessionIdsRef.current,
      );
      nextUnavailableSessionIds.delete(sessionId);
      unavailableSessionIdsRef.current = nextUnavailableSessionIds;
      if (nextUnavailableSessionIds.size === 0) {
        hasRefreshedUnavailableSessionsRef.current = false;
      }
    }
  }, [selectTarget]);

  const promoteSelectedTargetToExplicit = useCallback((
    target: ChatTarget,
  ): number => {
    const currentState = stateRef.current;
    const currentSelectionEpoch = selectionEpochRef.current;
    const nextState = promoteSelectedChatWorkspaceTargetToExplicit(
      currentState,
      target,
    );
    if (nextState === currentState) {
      return currentSelectionEpoch;
    }

    persistSelectedTarget(target, "explicit");
    commitState(nextState);
    return currentSelectionEpoch;
  }, [commitState, persistSelectedTarget]);

  const planSelectedDraftReuse = useCallback((): ChatDraftCreationPlan => {
    if (!isReadyRef.current) {
      throw new Error("Cannot reuse a chat draft before workspace readiness");
    }
    const currentState = stateRef.current;
    return resolveChatDraftCreationPlan({
      kind: "reuse_selected_draft",
      currentState,
      currentSelectionEpoch: selectionEpochRef.current,
      currentActiveDraftId: activeDraftIdRef.current,
    });
  }, []);

  const planDraftReplacement = useCallback((): ChatDraftCreationPlan =>
    resolveChatDraftCreationPlan({
      kind: "replace_selected_target",
      currentState: stateRef.current,
      currentSelectionEpoch: selectionEpochRef.current,
      currentActiveDraftId: activeDraftIdRef.current,
      nextDraftId: createDraftId(),
    }), []);

  const commitDraftCreation = useCallback((
    plan: ChatDraftCreationPlan,
  ): void => {
    const currentState = stateRef.current;
    if (
      selectionEpochRef.current !== plan.sourceSelectionEpoch
      || activeDraftIdRef.current !== plan.sourceActiveDraftId
      || currentState.selectionReason !== plan.sourceSelectionReason
      || !areChatTargetsEqual(currentState.target, plan.sourceTarget)
    ) {
      throw new Error(
        `Cannot commit stale chat draft creation plan from `
        + `"${getChatTargetKey(plan.sourceTarget)}" at selection epoch `
        + `${plan.sourceSelectionEpoch}`,
      );
    }
    if (plan.kind === "reuse") {
      return;
    }

    activeDraftIdRef.current = plan.target.draftId;
    commitSelectionEpoch(plan.selectionEpoch);
    commitState(selectChatWorkspaceTarget(
      currentState,
      plan.target,
      "explicit",
    ));
  }, [
    commitSelectionEpoch,
    commitState,
  ]);

  const finalizeDraftCreation = useCallback((
    plan: ChatDraftCreationPlan,
  ): void => {
    navigateToTarget(plan.target, plan.navigationMode);
  }, [navigateToTarget]);

  const isSelectionCurrent = useCallback((
    target: ChatTarget,
    expectedSelectionEpoch: number,
  ): boolean =>
    selectionEpochRef.current === expectedSelectionEpoch
    && areChatTargetsEqual(stateRef.current.target, target), []);

  const planDraftSessionAdoption = useCallback((
    draftId: string,
    sessionId: string,
    expectedSelectionEpoch: number,
  ): ChatDraftSessionAdoptionPlan => {
    const controllerTarget = stateRef.current.target;
    const controllerSelectionEpoch = selectionEpochRef.current;
    const controllerActiveDraftId = activeDraftIdRef.current;
    const adoption = resolveChatDraftSessionAdoption({
      currentTarget: controllerTarget,
      currentSelectionEpoch: controllerSelectionEpoch,
      draftId,
      sessionId,
      expectedSelectionEpoch,
    });
    const shouldTransferDraftState =
      adoption.kind === "selected"
      || adoption.draftStateDisposition === "transfer";
    return {
      draftId,
      sessionId,
      expectedSelectionEpoch,
      controllerTarget,
      controllerSelectionEpoch,
      controllerActiveDraftId,
      shouldClearActiveDraft:
        shouldTransferDraftState && controllerActiveDraftId === draftId,
      shouldPersistSelection: adoption.kind === "selected",
      adoption,
    };
  }, []);

  const commitDraftSessionAdoption = useCallback((
    plan: ChatDraftSessionAdoptionPlan,
  ): ChatDraftSessionAdoption => {
    if (
      selectionEpochRef.current !== plan.controllerSelectionEpoch
      || !areChatTargetsEqual(
        stateRef.current.target,
        plan.controllerTarget,
      )
      || activeDraftIdRef.current !== plan.controllerActiveDraftId
    ) {
      throw new Error(
        `Cannot commit stale chat draft adoption plan for `
        + `"${plan.draftId}" at selection epoch `
        + `${plan.expectedSelectionEpoch}`,
      );
    }

    if (plan.adoption.kind === "selected") {
      commitState(selectChatWorkspaceTarget(
        stateRef.current,
        plan.adoption.target,
        "explicit",
      ));
    }
    if (plan.shouldClearActiveDraft) {
      activeDraftIdRef.current = null;
    }
    return plan.adoption;
  }, [
    commitState,
  ]);

  const finalizeDraftSessionAdoption = useCallback((
    plan: ChatDraftSessionAdoptionPlan,
  ): void => {
    if (plan.adoption.kind === "selected") {
      navigateToTarget(plan.adoption.target, "replace");
    }
    void loadCatalogPage();
  }, [
    loadCatalogPage,
    navigateToTarget,
  ]);

  const observeSessionInvalidation = useCallback((
    sessionId: string,
    version: number,
    source: ChatWorkspaceInvalidationSource,
  ): void => {
    const currentState = stateRef.current;
    const previousVersion = currentState.mainContentInvalidationVersions.get(sessionId);
    const shouldPublish = version > (previousVersion ?? -1)
      && (previousVersion !== undefined || source === "live");
    commitState(observeChatSessionInvalidationVersion(
      currentState,
      sessionId,
      version,
    ));
    if (shouldPublish) {
      publishInvalidation(version);
    }
  }, [commitState, publishInvalidation]);

  const recoverInvalidSessionSelection = useCallback((
    sessionId: string,
    errorMessage: string,
  ): boolean => {
    const currentTarget = stateRef.current.target;
    if (
      currentTarget.kind !== "session"
      || currentTarget.sessionId !== sessionId
    ) {
      return false;
    }

    const unavailableSessionIds = new Set(
      unavailableSessionIdsRef.current,
    );
    unavailableSessionIds.add(sessionId);
    unavailableSessionIdsRef.current = unavailableSessionIds;
    automaticCatalogRecoveryPendingRef.current = true;
    recoverToSafeTarget(errorMessage, unavailableSessionIds);
    if (!hasRefreshedUnavailableSessionsRef.current) {
      hasRefreshedUnavailableSessionsRef.current = true;
      void refreshCatalog();
    }
    return true;
  }, [recoverToSafeTarget, refreshCatalog]);

  const historyErrorMessage = resolveChatHistoryErrorMessage(
    state.catalogRequest.errorMessage,
    recoveryNotice,
  );

  return {
    state,
    selectionEpoch,
    isReady,
    historyOpen,
    historyErrorMessage,
    runningCount,
    setHistoryOpen,
    selectSession,
    planSelectedDraftReuse,
    planDraftReplacement,
    commitDraftCreation,
    finalizeDraftCreation,
    promoteSelectedTargetToExplicit,
    planDraftSessionAdoption,
    commitDraftSessionAdoption,
    finalizeDraftSessionAdoption,
    isSelectionCurrent,
    refreshCatalog,
    loadNextCatalogPage,
    observeSessionInvalidation,
    recoverInvalidSessionSelection,
  };
};
