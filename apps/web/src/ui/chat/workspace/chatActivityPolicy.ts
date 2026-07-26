import {
  parseChatIdentifier,
  parseChatSessionTimestamp,
  type ChatSessionStatus,
} from "./chatSessionSummaryTransport";
import type { ChatSelectionReason } from "./chatWorkspaceState";

export const CHAT_INACTIVITY_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export type SelectedChatSessionActivity = Readonly<{
  sessionId: string;
  lastMessageAt: string;
  status: ChatSessionStatus;
}>;

export type ChatActivityPolicyInput = Readonly<{
  currentTimeMs: number;
  selectedSession: SelectedChatSessionActivity | null;
  selectionReason: ChatSelectionReason;
  inactivityThresholdMs: number;
}>;

export type ChatActivityPolicyDecision =
  | Readonly<{ kind: "select_draft" }>
  | Readonly<{ kind: "keep_session"; sessionId: string }>;

export type ChatPageVisibility = "hidden" | "visible";

const requireNonNegativeFiniteNumber = (
  value: number,
  context: string,
): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a finite non-negative number`);
  }

  return value;
};

export const resolveChatActivityPolicy = (
  input: ChatActivityPolicyInput,
): ChatActivityPolicyDecision => {
  const currentTimeMs = requireNonNegativeFiniteNumber(
    input.currentTimeMs,
    "Chat activity currentTimeMs",
  );
  const inactivityThresholdMs = requireNonNegativeFiniteNumber(
    input.inactivityThresholdMs,
    "Chat activity inactivityThresholdMs",
  );
  if (input.selectedSession === null) {
    return { kind: "select_draft" };
  }

  const sessionId = parseChatIdentifier(
    input.selectedSession.sessionId,
    "Chat activity sessionId",
  );
  if (
    input.selectedSession.status === "running"
    || input.selectionReason === "explicit"
  ) {
    return { kind: "keep_session", sessionId };
  }

  const lastMessageAt = parseChatSessionTimestamp(
    input.selectedSession.lastMessageAt,
    "Chat activity lastMessageAt",
  );
  const inactiveForMs = currentTimeMs - Date.parse(lastMessageAt);
  if (inactiveForMs > inactivityThresholdMs) {
    return { kind: "select_draft" };
  }

  return { kind: "keep_session", sessionId };
};

export const shouldReevaluateChatActivityAfterVisibilityChange = (
  previousVisibility: ChatPageVisibility,
  nextVisibility: ChatPageVisibility,
): boolean =>
  previousVisibility === "hidden" && nextVisibility === "visible";
