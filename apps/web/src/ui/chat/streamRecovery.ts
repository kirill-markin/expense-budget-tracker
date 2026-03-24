import type { StoredMessage } from "@/ui/hooks/useChatHistory";

export type ChatRunState = "idle" | "running" | "interrupted";

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

export const shouldSnapshotSetStreaming = (
  snapshotRunState: ChatRunState,
  isLiveStreamConnected: boolean,
  isUserStoppedSession: boolean,
): boolean =>
  getEffectiveSnapshotRunState(snapshotRunState, isUserStoppedSession) === "running"
    && !isLiveStreamConnected;

export const shouldSuppressStreamFailure = (
  snapshot: ChatSnapshotState,
): boolean =>
  snapshot.runState === "running" || snapshot.runState === "idle";

/**
 * Returns whether a live SSE tool-call event should refresh the main content.
 *
 * Live events should refresh immediately on the first seen invalidation version
 * because there is no earlier snapshot in memory for that completed tool call.
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
 * version than the client has already seen.
 */
export const shouldRefreshMainContentFromSnapshot = (
  previousVersion: number | null,
  nextVersion: number,
): boolean =>
  previousVersion !== null && nextVersion > previousVersion;
