import type { StoredMessage } from "@/ui/hooks/useChatHistory";

export type ChatRunState = "idle" | "running" | "interrupted";

export type ChatSnapshotState = Readonly<{
  runState: ChatRunState;
  updatedAt: number;
  messages: ReadonlyArray<StoredMessage>;
}>;

export const ACTIVE_RUN_SNAPSHOT_POLL_INTERVAL_MS = 10_000;

export const shouldReplaceHistoryFromSnapshot = (
  previousUpdatedAt: number | null,
  snapshotUpdatedAt: number,
): boolean =>
  previousUpdatedAt === null || snapshotUpdatedAt > previousUpdatedAt;

export const shouldSuppressStreamFailure = (
  snapshot: ChatSnapshotState,
): boolean =>
  snapshot.runState === "running" || snapshot.runState === "idle";
