import {
  mergeChatSessionSummaries,
  parseChatIdentifier,
  type ChatSessionSummary,
  type ChatSessionSummaryPage,
} from "./chatSessionSummaryTransport";
import {
  CHAT_INACTIVITY_THRESHOLD_MS,
  resolveChatActivityPolicy,
} from "./chatActivityPolicy";

export type ChatTarget =
  | Readonly<{ kind: "draft"; draftId: string }>
  | Readonly<{ kind: "session"; sessionId: string }>;

export type ChatSelectionReason = "automatic" | "explicit";

export type ChatCatalogPaginationState = Readonly<{
  hasLoadedFirstPage: boolean;
  nextCursor: string | null;
}>;

export type ChatCatalogRequestState = Readonly<{
  isLoading: boolean;
  errorMessage: string | null;
}>;

export type ChatWorkspaceState = Readonly<{
  summaries: ReadonlyArray<ChatSessionSummary>;
  target: ChatTarget;
  selectionReason: ChatSelectionReason;
  mainContentInvalidationVersions: ReadonlyMap<string, number>;
  pagination: ChatCatalogPaginationState;
  catalogRequest: ChatCatalogRequestState;
}>;

export type ChatSessionInvalidationIncrement = Readonly<{
  sessionId: string;
  previousVersion: number;
  nextVersion: number;
}>;

const requireChatTarget = (
  target: ChatTarget,
): ChatTarget =>
  target.kind === "draft"
    ? {
      kind: "draft",
      draftId: parseChatIdentifier(target.draftId, "Chat draft target draftId"),
    }
    : {
      kind: "session",
      sessionId: parseChatIdentifier(
        target.sessionId,
        "Chat session target sessionId",
      ),
    };

export const getChatTargetKey = (
  target: ChatTarget,
): string => {
  const validTarget = requireChatTarget(target);
  return validTarget.kind === "draft"
    ? `draft:${validTarget.draftId}`
    : `session:${validTarget.sessionId}`;
};

export const areChatTargetsEqual = (
  firstTarget: ChatTarget,
  secondTarget: ChatTarget,
): boolean =>
  getChatTargetKey(firstTarget) === getChatTargetKey(secondTarget);

export const resolveNewChatDraftTarget = (
  currentTarget: ChatTarget,
  activeDraftId: string | null,
  isCurrentDraftUntouched: boolean,
  nextDraftId: string,
): ChatTarget => {
  if (currentTarget.kind === "draft" && isCurrentDraftUntouched) {
    return requireChatTarget(currentTarget);
  }
  if (currentTarget.kind === "session" && activeDraftId !== null) {
    return requireChatTarget({ kind: "draft", draftId: activeDraftId });
  }

  return requireChatTarget({ kind: "draft", draftId: nextDraftId });
};

export const resolveAutomaticChatTarget = (
  summaries: ReadonlyArray<ChatSessionSummary>,
  currentTimeMs: number,
  draftId: string,
): ChatTarget => {
  const selectedSession = summaries[0] ?? null;
  const decision = resolveChatActivityPolicy({
    currentTimeMs,
    selectedSession,
    selectionReason: "automatic",
    inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
  });

  return decision.kind === "select_draft"
    ? requireChatTarget({ kind: "draft", draftId })
    : requireChatTarget({ kind: "session", sessionId: decision.sessionId });
};

export const resolveAutomaticChatTargetAfterRefresh = (
  summaries: ReadonlyArray<ChatSessionSummary>,
  currentTarget: ChatTarget,
  currentTimeMs: number,
  draftId: string,
): ChatTarget => {
  const validCurrentTarget = requireChatTarget(currentTarget);
  if (validCurrentTarget.kind === "session") {
    const selectedSession = summaries.find(
      (summary): boolean =>
        summary.sessionId === validCurrentTarget.sessionId,
    );
    if (selectedSession !== undefined) {
      const decision = resolveChatActivityPolicy({
        currentTimeMs,
        selectedSession,
        selectionReason: "automatic",
        inactivityThresholdMs: CHAT_INACTIVITY_THRESHOLD_MS,
      });
      return decision.kind === "select_draft"
        ? requireChatTarget({ kind: "draft", draftId })
        : validCurrentTarget;
    }
  }

  return resolveAutomaticChatTarget(summaries, currentTimeMs, draftId);
};

export const resolveFailedSessionRecoveryTarget = (
  summaries: ReadonlyArray<ChatSessionSummary>,
  failedSessionIds: ReadonlySet<string>,
  currentTimeMs: number,
  draftId: string,
): ChatTarget => {
  const validFailedSessionIds = new Set(
    [...failedSessionIds].map(
      (sessionId: string): string => parseChatIdentifier(
        sessionId,
        "Failed chat session recovery sessionId",
      ),
    ),
  );
  return resolveAutomaticChatTarget(
    summaries.filter(
      (summary): boolean => !validFailedSessionIds.has(summary.sessionId),
    ),
    currentTimeMs,
    draftId,
  );
};

const requireErrorMessage = (errorMessage: string): string => {
  if (errorMessage.trim().length === 0) {
    throw new Error("Chat session catalog error message must not be empty");
  }

  return errorMessage;
};

export const createChatWorkspaceState = (
  target: ChatTarget,
  selectionReason: ChatSelectionReason,
): ChatWorkspaceState => ({
  summaries: [],
  target: requireChatTarget(target),
  selectionReason,
  mainContentInvalidationVersions: new Map<string, number>(),
  pagination: {
    hasLoadedFirstPage: false,
    nextCursor: null,
  },
  catalogRequest: {
    isLoading: false,
    errorMessage: null,
  },
});

export const selectChatWorkspaceTarget = (
  state: ChatWorkspaceState,
  target: ChatTarget,
  selectionReason: ChatSelectionReason,
): ChatWorkspaceState => ({
  ...state,
  target: requireChatTarget(target),
  selectionReason,
});

export const startChatSessionCatalogLoad = (
  state: ChatWorkspaceState,
): ChatWorkspaceState => ({
  ...state,
  catalogRequest: {
    isLoading: true,
    errorMessage: null,
  },
});

export const updateChatSessionInvalidationVersions = (
  currentVersions: ReadonlyMap<string, number>,
  summaries: ReadonlyArray<ChatSessionSummary>,
): ReadonlyMap<string, number> => {
  const nextVersions = new Map(currentVersions);
  for (const summary of mergeChatSessionSummaries([], summaries)) {
    const currentVersion = nextVersions.get(summary.sessionId);
    if (
      currentVersion === undefined
      || summary.mainContentInvalidationVersion > currentVersion
    ) {
      nextVersions.set(
        summary.sessionId,
        summary.mainContentInvalidationVersion,
      );
    }
  }

  return nextVersions;
};

export const observeChatSessionInvalidationVersion = (
  state: ChatWorkspaceState,
  sessionId: string,
  version: number,
): ChatWorkspaceState => {
  const validSessionId = parseChatIdentifier(
    sessionId,
    "Chat invalidation sessionId",
  );
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Chat invalidation version must be a non-negative safe integer");
  }

  const previousVersion = state.mainContentInvalidationVersions.get(validSessionId);
  if (previousVersion !== undefined && previousVersion >= version) {
    return state;
  }

  const nextVersions = new Map(state.mainContentInvalidationVersions);
  nextVersions.set(validSessionId, version);
  return {
    ...state,
    mainContentInvalidationVersions: nextVersions,
  };
};

export const findChatSessionInvalidationIncrements = (
  currentVersions: ReadonlyMap<string, number>,
  summaries: ReadonlyArray<ChatSessionSummary>,
): ReadonlyArray<ChatSessionInvalidationIncrement> => {
  const increments: Array<ChatSessionInvalidationIncrement> = [];
  for (const summary of mergeChatSessionSummaries([], summaries)) {
    const currentVersion = currentVersions.get(summary.sessionId);
    if (
      currentVersion !== undefined
      && summary.mainContentInvalidationVersion > currentVersion
    ) {
      increments.push({
        sessionId: summary.sessionId,
        previousVersion: currentVersion,
        nextVersion: summary.mainContentInvalidationVersion,
      });
    }
  }

  return increments;
};

const createLoadedCatalogState = (
  state: ChatWorkspaceState,
  summaries: ReadonlyArray<ChatSessionSummary>,
  nextCursor: string | null,
): ChatWorkspaceState => ({
  ...state,
  summaries,
  mainContentInvalidationVersions: updateChatSessionInvalidationVersions(
    state.mainContentInvalidationVersions,
    summaries,
  ),
  pagination: {
    hasLoadedFirstPage: true,
    nextCursor,
  },
  catalogRequest: {
    isLoading: false,
    errorMessage: null,
  },
});

export const replaceChatSessionCatalog = (
  state: ChatWorkspaceState,
  page: ChatSessionSummaryPage,
): ChatWorkspaceState =>
  createLoadedCatalogState(
    state,
    mergeChatSessionSummaries([], page.sessions),
    page.nextCursor,
  );

export const appendChatSessionCatalogPage = (
  state: ChatWorkspaceState,
  page: ChatSessionSummaryPage,
): ChatWorkspaceState => {
  if (!state.pagination.hasLoadedFirstPage) {
    throw new Error(
      "Cannot append a chat session catalog page before loading the first page",
    );
  }

  return createLoadedCatalogState(
    state,
    mergeChatSessionSummaries(state.summaries, page.sessions),
    page.nextCursor,
  );
};

export const failChatSessionCatalogLoad = (
  state: ChatWorkspaceState,
  errorMessage: string,
): ChatWorkspaceState => ({
  ...state,
  catalogRequest: {
    isLoading: false,
    errorMessage: requireErrorMessage(errorMessage),
  },
});

export const getRunningChatSessionCount = (
  summaries: ReadonlyArray<ChatSessionSummary>,
): number =>
  summaries.reduce(
    (count, summary): number =>
      summary.status === "running" ? count + 1 : count,
    0,
  );
