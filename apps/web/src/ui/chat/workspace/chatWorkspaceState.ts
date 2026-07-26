import {
  mergeChatSessionSummaries,
  parseChatIdentifier,
  type ChatSessionSummary,
  type ChatSessionSummaryPage,
} from "./chatSessionSummaryTransport";

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
