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

export type ChatSessionControllerState = Readonly<{
  isHistoryLoaded: boolean;
  currentSessionId: string | null;
  runState: ChatRunState;
  isLiveStreamConnected: boolean;
  isStopping: boolean;
  lastSnapshotUpdatedAt: number | null;
  lastMainContentInvalidationVersion: number | null;
  stoppedSessionIds: ReadonlySet<string>;
}>;

export type ChatSessionControllerAction =
  | Readonly<{ type: "workspace_reset" }>
  | Readonly<{ type: "bootstrap_succeeded" }>
  | Readonly<{ type: "bootstrap_failed" }>
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
  | Readonly<{ type: "stop_completed" }>
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

const removeStoppedSession = (
  stoppedSessionIds: ReadonlySet<string>,
  sessionId: string,
): ReadonlySet<string> => {
  if (!stoppedSessionIds.has(sessionId)) {
    return stoppedSessionIds;
  }

  const nextStoppedSessionIds = new Set(stoppedSessionIds);
  nextStoppedSessionIds.delete(sessionId);
  return nextStoppedSessionIds;
};

export const createInitialChatSessionControllerState = (): ChatSessionControllerState => ({
  isHistoryLoaded: false,
  currentSessionId: null,
  runState: "idle",
  isLiveStreamConnected: false,
  isStopping: false,
  lastSnapshotUpdatedAt: null,
  lastMainContentInvalidationVersion: null,
  stoppedSessionIds: new Set<string>(),
});

export const reduceChatSessionControllerState = (
  state: ChatSessionControllerState,
  action: ChatSessionControllerAction,
): ChatSessionControllerState => {
  switch (action.type) {
    case "workspace_reset":
      return createInitialChatSessionControllerState();
    case "bootstrap_succeeded":
    case "bootstrap_failed":
      return {
        ...state,
        isHistoryLoaded: true,
      };
    case "snapshot_applied":
      return {
        ...state,
        currentSessionId: action.sessionId,
        runState: getEffectiveSnapshotRunState(
          action.runState,
          state.stoppedSessionIds.has(action.sessionId),
        ),
        lastSnapshotUpdatedAt: action.updatedAt,
        lastMainContentInvalidationVersion: mergeInvalidationVersion(
          state.lastMainContentInvalidationVersion,
          action.mainContentInvalidationVersion,
        ),
      };
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
        stoppedSessionIds: new Set<string>(),
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
        isStopping: true,
        stoppedSessionIds: new Set([...state.stoppedSessionIds, action.sessionId]),
      };
    case "stop_completed":
      return {
        ...state,
        isStopping: false,
      };
    case "stopped_session_cleared":
      return {
        ...state,
        stoppedSessionIds: removeStoppedSession(state.stoppedSessionIds, action.sessionId),
      };
    case "conversation_cleared":
      return {
        ...state,
        currentSessionId: action.sessionId,
        runState: "idle",
        isLiveStreamConnected: false,
        isStopping: false,
        lastMainContentInvalidationVersion: 0,
        stoppedSessionIds: state.currentSessionId === null
          ? state.stoppedSessionIds
          : removeStoppedSession(state.stoppedSessionIds, state.currentSessionId),
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

export const selectComposerAction = (
  state: ChatSessionControllerState,
): ChatComposerAction =>
  getChatComposerAction(state.runState);
