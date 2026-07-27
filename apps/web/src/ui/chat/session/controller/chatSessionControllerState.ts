"use client";

import {
  getChatComposerAction,
  getEffectiveSnapshotRunState,
  isChatRunActive,
  shouldRefreshMainContentFromLiveEvent,
  shouldRefreshMainContentFromSnapshot,
  shouldReplaceHistoryFromSnapshot,
  type ChatComposerAction,
  type ChatRunState,
} from "../../stream/streamRecovery";

export type ChatMainContentInvalidationSource = "live" | "snapshot";
export type ChatBootstrapStatus = "loading" | "ready" | "failed" | "blocked";

export type ChatSessionControllerState = Readonly<{
  isHistoryLoaded: boolean;
  bootstrapStatus: ChatBootstrapStatus;
  currentSessionId: string | null;
  runState: ChatRunState;
  isLiveStreamConnected: boolean;
  lastSnapshotUpdatedAt: number | null;
  lastMainContentInvalidationVersion: number | null;
  stoppedSessionIds: ReadonlySet<string>;
  stoppingSessionIds: ReadonlySet<string>;
}>;

export type ChatSessionControllerAction =
  | Readonly<{ type: "workspace_reset" }>
  | Readonly<{ type: "selection_changed"; sessionId: string | null }>
  | Readonly<{ type: "bootstrap_succeeded" }>
  | Readonly<{ type: "bootstrap_failed" }>
  | Readonly<{ type: "bootstrap_blocked" }>
  | Readonly<{
    type: "external_session_change_observed";
    sessionId: string;
  }>
  | Readonly<{
    type: "snapshot_applied";
    sessionId: string;
    runState: ChatRunState;
    updatedAt: number;
    mainContentInvalidationVersion: number;
  }>
  | Readonly<{ type: "main_content_invalidation_observed"; version: number }>
  | Readonly<{ type: "live_stream_connected" }>
  | Readonly<{ type: "live_stream_disconnected" }>
  | Readonly<{ type: "run_started" }>
  | Readonly<{ type: "run_finished" }>
  | Readonly<{ type: "run_interrupted" }>
  | Readonly<{ type: "stop_requested"; sessionId: string }>
  | Readonly<{ type: "stop_completed"; sessionId: string }>
  | Readonly<{ type: "stop_failed"; sessionId: string }>
  | Readonly<{ type: "stopped_session_cleared"; sessionId: string }>
  | Readonly<{ type: "conversation_cleared"; sessionId: string }>
  | Readonly<{ type: "server_session_accepted"; sessionId: string }>
  | Readonly<{ type: "server_session_created"; sessionId: string }>;

const mergeInvalidationVersion = (
  previousVersion: number | null,
  nextVersion: number,
): number =>
  previousVersion === null
    ? nextVersion
    : Math.max(previousVersion, nextVersion);

const removeSessionId = (
  sessionIds: ReadonlySet<string>,
  sessionId: string,
): ReadonlySet<string> => {
  if (!sessionIds.has(sessionId)) {
    return sessionIds;
  }

  const nextSessionIds = new Set(sessionIds);
  nextSessionIds.delete(sessionId);
  return nextSessionIds;
};

export const createInitialChatSessionControllerState = (): ChatSessionControllerState => ({
  isHistoryLoaded: false,
  bootstrapStatus: "loading",
  currentSessionId: null,
  runState: "idle",
  isLiveStreamConnected: false,
  lastSnapshotUpdatedAt: null,
  lastMainContentInvalidationVersion: null,
  stoppedSessionIds: new Set<string>(),
  stoppingSessionIds: new Set<string>(),
});

export const reduceChatSessionControllerState = (
  state: ChatSessionControllerState,
  action: ChatSessionControllerAction,
): ChatSessionControllerState => {
  switch (action.type) {
    case "workspace_reset":
      return createInitialChatSessionControllerState();
    case "selection_changed":
      return {
        ...createInitialChatSessionControllerState(),
        currentSessionId: action.sessionId,
        stoppedSessionIds: state.stoppedSessionIds,
        stoppingSessionIds: state.stoppingSessionIds,
      };
    case "bootstrap_succeeded":
      return {
        ...state,
        isHistoryLoaded: true,
        bootstrapStatus: "ready",
      };
    case "bootstrap_failed":
      return {
        ...state,
        isHistoryLoaded: true,
        bootstrapStatus: "failed",
      };
    case "bootstrap_blocked":
      return {
        ...state,
        isHistoryLoaded: false,
        bootstrapStatus: "blocked",
      };
    case "external_session_change_observed":
      if (state.currentSessionId !== action.sessionId) {
        return state;
      }
      return {
        ...state,
        isHistoryLoaded: false,
        bootstrapStatus: "loading",
      };
    case "snapshot_applied": {
      const stoppedSessionIds = action.runState === "idle"
        ? removeSessionId(state.stoppedSessionIds, action.sessionId)
        : state.stoppedSessionIds;
      return {
        ...state,
        isHistoryLoaded: true,
        bootstrapStatus: "ready",
        currentSessionId: action.sessionId,
        runState: getEffectiveSnapshotRunState(
          action.runState,
          stoppedSessionIds.has(action.sessionId),
        ),
        stoppedSessionIds,
        lastSnapshotUpdatedAt: action.updatedAt,
        lastMainContentInvalidationVersion: mergeInvalidationVersion(
          state.lastMainContentInvalidationVersion,
          action.mainContentInvalidationVersion,
        ),
      };
    }
    case "main_content_invalidation_observed":
      return {
        ...state,
        lastMainContentInvalidationVersion: mergeInvalidationVersion(
          state.lastMainContentInvalidationVersion,
          action.version,
        ),
      };
    case "live_stream_connected":
      return {
        ...state,
        isLiveStreamConnected: true,
      };
    case "live_stream_disconnected":
      return {
        ...state,
        isLiveStreamConnected: false,
      };
    case "run_started":
      return {
        ...state,
        runState: "running",
        isLiveStreamConnected: false,
        stoppedSessionIds: state.currentSessionId === null
          ? state.stoppedSessionIds
          : removeSessionId(
            state.stoppedSessionIds,
            state.currentSessionId,
          ),
      };
    case "run_finished":
      return {
        ...state,
        runState: "idle",
        isLiveStreamConnected: false,
      };
    case "run_interrupted":
      return {
        ...state,
        runState: "interrupted",
        isLiveStreamConnected: false,
      };
    case "stop_requested":
      return {
        ...state,
        stoppedSessionIds: new Set([...state.stoppedSessionIds, action.sessionId]),
        stoppingSessionIds: new Set([...state.stoppingSessionIds, action.sessionId]),
      };
    case "stop_completed":
      return {
        ...state,
        stoppedSessionIds: removeSessionId(
          state.stoppedSessionIds,
          action.sessionId,
        ),
        stoppingSessionIds: removeSessionId(
          state.stoppingSessionIds,
          action.sessionId,
        ),
      };
    case "stop_failed":
      return {
        ...state,
        stoppedSessionIds: removeSessionId(
          state.stoppedSessionIds,
          action.sessionId,
        ),
        stoppingSessionIds: removeSessionId(
          state.stoppingSessionIds,
          action.sessionId,
        ),
      };
    case "stopped_session_cleared":
      return {
        ...state,
        stoppedSessionIds: removeSessionId(state.stoppedSessionIds, action.sessionId),
      };
    case "conversation_cleared":
      return {
        ...state,
        currentSessionId: action.sessionId,
        runState: "idle",
        isLiveStreamConnected: false,
        lastMainContentInvalidationVersion: 0,
        stoppedSessionIds: state.currentSessionId === null
          ? state.stoppedSessionIds
          : removeSessionId(state.stoppedSessionIds, state.currentSessionId),
        stoppingSessionIds: state.currentSessionId === null
          ? state.stoppingSessionIds
          : removeSessionId(state.stoppingSessionIds, state.currentSessionId),
      };
    case "server_session_accepted":
      return {
        ...state,
        currentSessionId: action.sessionId,
      };
    case "server_session_created":
      return {
        ...state,
        currentSessionId: action.sessionId,
        lastMainContentInvalidationVersion: 0,
      };
    default:
      return state;
  }
};

export const shouldRefreshMainContentForVersion = (
  state: ChatSessionControllerState,
  source: ChatMainContentInvalidationSource,
  nextVersion: number,
): boolean =>
  source === "live"
    ? shouldRefreshMainContentFromLiveEvent(
      state.lastMainContentInvalidationVersion,
      nextVersion,
    )
    : shouldRefreshMainContentFromSnapshot(
      state.lastMainContentInvalidationVersion,
      nextVersion,
    );

export const shouldReplaceHistoryForSnapshot = (
  state: ChatSessionControllerState,
  snapshotUpdatedAt: number,
): boolean =>
  shouldReplaceHistoryFromSnapshot(state.lastSnapshotUpdatedAt, snapshotUpdatedAt);

export const selectEffectiveSnapshotRunState = (
  state: ChatSessionControllerState,
  sessionId: string,
  snapshotRunState: ChatRunState,
): ChatRunState =>
  getEffectiveSnapshotRunState(
    snapshotRunState,
    state.stoppedSessionIds.has(sessionId),
  );

export const selectIsAssistantRunActive = (
  state: ChatSessionControllerState,
): boolean =>
  isChatRunActive(state.runState);

export const selectIsSelectedSessionStopping = (
  state: ChatSessionControllerState,
): boolean =>
  state.currentSessionId !== null
  && state.stoppingSessionIds.has(state.currentSessionId);

export const selectComposerAction = (
  state: ChatSessionControllerState,
): ChatComposerAction =>
  getChatComposerAction(state.runState);
