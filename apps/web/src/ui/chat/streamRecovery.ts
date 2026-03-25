import type { StoredMessage } from "@/ui/hooks/useChatHistory";

export type ChatRunState = "idle" | "running" | "interrupted";
export type ChatComposerAction = "send" | "stop";

/**
 * Snapshot shape consumed by the client polling/recovery path.
 *
 * Polling is a supported transport for chat updates alongside live SSE, so the
 * snapshot includes the same persisted invalidation version used to refresh
 * route-backed main content after mutating database tool calls.
 */
export type ChatSnapshotState = Readonly<{
  runState: ChatRunState;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ReadonlyArray<StoredMessage>;
}>;

export const ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS = 10_000;

export const shouldReplaceHistoryFromSnapshot = (
  previousUpdatedAt: number | null,
  snapshotUpdatedAt: number,
): boolean =>
  previousUpdatedAt === null || snapshotUpdatedAt > previousUpdatedAt;

export const getEffectiveSnapshotRunState = (
  snapshotRunState: ChatRunState,
  isUserStoppedSession: boolean,
): ChatRunState =>
  isUserStoppedSession && snapshotRunState === "running"
    ? "idle"
    : snapshotRunState;

/**
 * Returns whether the UI should continue presenting the assistant as active.
 *
 * This is intentionally derived from the persisted session run state instead of
 * the local SSE connection. Polling remains a first-class delivery path after a
 * live stream disconnects, so the absence of an open reader must not hide
 * active-run affordances such as the stop button or animated progress dots.
 */
export const isChatRunActive = (
  runState: ChatRunState,
): boolean =>
  runState === "running";

/**
 * Chooses the composer action that the user should see for the current run
 * state.
 *
 * The composer exposes `Stop` whenever the persisted session still reports an
 * active run, even if the browser no longer has a live SSE connection. This
 * keeps the UI aligned with server truth and prevents a false `Send` state
 * during snapshot-based recovery.
 */
export const getChatComposerAction = (
  runState: ChatRunState,
): ChatComposerAction =>
  isChatRunActive(runState) ? "stop" : "send";

export const shouldSuppressStreamFailure = (
  snapshot: ChatSnapshotState,
): boolean =>
  snapshot.runState === "running" || snapshot.runState === "idle";

/**
 * Returns whether a live SSE tool-call event should refresh the main content.
 *
 * Live events should refresh immediately on the first seen invalidation
 * version because there is no earlier snapshot in memory for that completed
 * tool call. The presence of the version, not the mere fact that the
 * transcript says `completed`, is the refresh contract.
 */
export const shouldRefreshMainContentFromLiveEvent = (
  previousVersion: number | null,
  nextVersion: number,
): boolean =>
  previousVersion === null || nextVersion > previousVersion;

/**
 * Returns whether a `/api/chat` snapshot loaded through polling/recovery should
 * refresh the main content.
 *
 * Snapshot polling must not refresh on the initial bootstrap load because the
 * version may already reflect older completed tool calls from previous turns.
 * It refreshes only when polling observes a newer persisted invalidation
 * version than the client has already seen, which lets snapshot recovery act
 * as the fallback when a live SSE completion event is missed.
 */
export const shouldRefreshMainContentFromSnapshot = (
  previousVersion: number | null,
  nextVersion: number,
): boolean =>
  previousVersion !== null && nextVersion > previousVersion;
