import { createHash } from "node:crypto";
import {
  CHAT_FALLBACK_MODEL_ID,
  CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
  type ChatEffectiveModelId,
  type ChatEffectiveReasoningEffort,
} from "@/lib/chatModels";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import type { FileContentPart } from "@/server/chat/types";

export const CHAT_MODEL_ROLLING_WINDOW_HOURS = 24;
export const CHAT_MODEL_ROLLING_USER_MESSAGE_THRESHOLD = 30;
export const CHAT_MODEL_SESSION_PDF_THRESHOLD = 4;
export const CHAT_MODEL_SESSION_USER_MESSAGE_THRESHOLD = 5;

export type ChatModelRoutingReason =
  | "default"
  | "rolling_24h_user_messages"
  | "pdf_heavy_session"
  | "rolling_24h_user_messages_and_pdf_heavy_session";

export type ChatModelRoutingDecision = Readonly<{
  effectiveModel: ChatEffectiveModelId;
  effectiveReasoningEffort: ChatEffectiveReasoningEffort;
  reason: ChatModelRoutingReason;
  rolling24HourUserMessageCount: number;
  sessionUserMessageCount: number;
  sessionUniquePdfCount: number;
}>;

export type ChatModelRoutingLogEvent = Readonly<{
  domain: "chat";
  action: "model_routing";
  vendor: "openai";
  requestedModel: string;
  defaultModel: typeof CHAT_MODEL_ID;
  effectiveModel: ChatEffectiveModelId;
  effectiveReasoningEffort: ChatEffectiveReasoningEffort;
  routingReason: ChatModelRoutingReason;
  rollingWindowHours: typeof CHAT_MODEL_ROLLING_WINDOW_HOURS;
  rolling24HourUserMessageCount: number;
  rollingUserMessageThreshold: typeof CHAT_MODEL_ROLLING_USER_MESSAGE_THRESHOLD;
  sessionUserMessageCount: number;
  sessionUserMessageThreshold: typeof CHAT_MODEL_SESSION_USER_MESSAGE_THRESHOLD;
  sessionUniquePdfCount: number;
  sessionPdfThreshold: typeof CHAT_MODEL_SESSION_PDF_THRESHOLD;
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
}>;

const isValidatedPdfAttachment = (
  part: FileContentPart,
): boolean =>
  part.mediaType.trim().toLowerCase() === "application/pdf";

const getPdfContentFingerprint = (
  part: FileContentPart,
): string =>
  createHash("sha256")
    .update(Buffer.from(part.base64Data, "base64"))
    .digest("hex");

export const countUniquePdfAttachments = (
  messages: ReadonlyArray<ServerChatMessage>,
): number => {
  const fingerprints = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "file" && isValidatedPdfAttachment(part)) {
        fingerprints.add(getPdfContentFingerprint(part));
      }
    }
  }
  return fingerprints.size;
};

export const getChatModelRollingWindowStart = (
  evaluatedAt: Date,
): Date => {
  const evaluatedAtMs = evaluatedAt.getTime();
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new TypeError("Chat model routing evaluation time must be a valid date");
  }

  return new Date(
    evaluatedAtMs - CHAT_MODEL_ROLLING_WINDOW_HOURS * 60 * 60 * 1000,
  );
};

const requireMessageCount = (
  count: number,
  countName: string,
): number => {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Chat model routing ${countName} must be a non-negative safe integer: ${String(count)}`);
  }
  return count;
};

export const selectChatModelRouting = (
  rolling24HourUserMessageCount: number,
  messages: ReadonlyArray<ServerChatMessage>,
): ChatModelRoutingDecision => {
  const validatedRollingMessageCount = requireMessageCount(
    rolling24HourUserMessageCount,
    "rolling 24-hour user message count",
  );
  const sessionUserMessageCount = messages.filter(
    (message) => message.role === "user",
  ).length;
  const sessionUniquePdfCount = countUniquePdfAttachments(messages);
  const reachedRollingThreshold = validatedRollingMessageCount
    >= CHAT_MODEL_ROLLING_USER_MESSAGE_THRESHOLD;
  const reachedPdfSessionThreshold = sessionUserMessageCount
    >= CHAT_MODEL_SESSION_USER_MESSAGE_THRESHOLD
    && sessionUniquePdfCount >= CHAT_MODEL_SESSION_PDF_THRESHOLD;

  const reason: ChatModelRoutingReason = reachedRollingThreshold
    ? reachedPdfSessionThreshold
      ? "rolling_24h_user_messages_and_pdf_heavy_session"
      : "rolling_24h_user_messages"
    : reachedPdfSessionThreshold
      ? "pdf_heavy_session"
      : "default";
  const useFallback = reachedRollingThreshold || reachedPdfSessionThreshold;

  return {
    effectiveModel: useFallback ? CHAT_FALLBACK_MODEL_ID : CHAT_MODEL_ID,
    effectiveReasoningEffort: useFallback
      ? CHAT_FALLBACK_MODEL_REASONING_EFFORT
      : CHAT_MODEL_REASONING_EFFORT,
    reason,
    rolling24HourUserMessageCount: validatedRollingMessageCount,
    sessionUserMessageCount,
    sessionUniquePdfCount,
  };
};

export const createChatModelRoutingLogEvent = (
  params: Readonly<{
    requestedModel: string;
    decision: ChatModelRoutingDecision;
    requestId: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
  }>,
): ChatModelRoutingLogEvent => ({
  domain: "chat",
  action: "model_routing",
  vendor: "openai",
  requestedModel: params.requestedModel,
  defaultModel: CHAT_MODEL_ID,
  effectiveModel: params.decision.effectiveModel,
  effectiveReasoningEffort: params.decision.effectiveReasoningEffort,
  routingReason: params.decision.reason,
  rollingWindowHours: CHAT_MODEL_ROLLING_WINDOW_HOURS,
  rolling24HourUserMessageCount: params.decision.rolling24HourUserMessageCount,
  rollingUserMessageThreshold: CHAT_MODEL_ROLLING_USER_MESSAGE_THRESHOLD,
  sessionUserMessageCount: params.decision.sessionUserMessageCount,
  sessionUserMessageThreshold: CHAT_MODEL_SESSION_USER_MESSAGE_THRESHOLD,
  sessionUniquePdfCount: params.decision.sessionUniquePdfCount,
  sessionPdfThreshold: CHAT_MODEL_SESSION_PDF_THRESHOLD,
  requestId: params.requestId,
  userId: params.userId,
  workspaceId: params.workspaceId,
  sessionId: params.sessionId,
});
