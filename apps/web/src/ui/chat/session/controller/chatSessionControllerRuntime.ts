"use client";

import { fetchWithCsrf } from "@/lib/csrf";
import {
  hasHeicFileSignature,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  OPENAI_IMAGE_MIME_TYPES,
} from "@/lib/chatImageFormats";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { StoredMessage } from "@/lib/chatHistory";
import type { ContentPart } from "@/server/chat/types";
import type { PendingAttachment } from "../../shell/panel/FileAttachment";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
import {
  areChatTargetsEqual,
  type ChatTarget,
} from "../../workspace/chatWorkspaceState";
import {
  applyChatStreamEvent,
  drainChatStreamChunk,
  type ChatStreamTransportHandlers,
} from "../../stream/chatStreamTransport";

type TranslationParams = Readonly<Record<string, string | number>>;

export type ChatTranslation = (
  key: string,
  params?: TranslationParams,
) => string;

type StopChatSessionResponseBase = Readonly<{
  ok: true;
  sessionId: string;
  stopped: boolean;
  stillRunning: boolean;
}>;

export type SessionLevelStopChatSessionResponse =
  StopChatSessionResponseBase & Readonly<{
    turnId?: undefined;
    cancellationConfirmed?: undefined;
  }>;

export type ExactTurnStopChatSessionResponse =
  StopChatSessionResponseBase & Readonly<{
    turnId: string;
    cancellationConfirmed: true;
  }>;

export type StopChatSessionResponse =
  | SessionLevelStopChatSessionResponse
  | ExactTurnStopChatSessionResponse;

type ChatMessageRequestBody = Readonly<{
  model: string;
  content: ReadonlyArray<ContentPart>;
  timezone: string;
}>;

type ExistingChatSendRequestBody = ChatMessageRequestBody & Readonly<{
  sessionId: string;
  turnId: string;
}>;

export type PreparedChatSendRequest =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
    kind: "invalid_attachment";
    errorMessage: string;
  }>
  | Readonly<{
    kind: "too_large";
    contentParts: ReadonlyArray<ContentPart>;
    errorMessage: string;
  }>
  | Readonly<{
    kind: "ready";
    contentParts: ReadonlyArray<ContentPart>;
  }>;

export type StreamChatResponseParams = Readonly<{
  url: "/api/chat" | "/api/chat/new";
  requestBody: string;
  signal: AbortSignal;
  abortStream: () => void;
  t: ChatTranslation;
  handlers: ChatStreamTransportHandlers;
  onSessionIdReceived: (sessionId: string) => void;
  onLiveStreamConnected: () => void;
}>;

export type StreamChatFailureStage = "request" | "stream" | null;

export type ChatRequestAcceptance =
  | "unknown"
  | "rejected"
  | "accepted";

export type StreamChatResponseResult = Readonly<{
  responseSessionId: string | null;
  streamFailure: Error | null;
  failureStage: StreamChatFailureStage;
  receivedContent: boolean;
  wasAborted: boolean;
  requestAcceptance: ChatRequestAcceptance;
}>;

export type ChatSendReconciliationOwner = Readonly<{
  ownerId: symbol;
  sessionId: string;
  turnId: string;
}>;

export type ChatStopOperationOwner = Readonly<{
  ownerId: symbol;
  sessionId: string;
  abortController: AbortController;
}>;

export type ChatSendTransport = Readonly<{
  url: "/api/chat" | "/api/chat/new";
  requestBody: string;
}>;

export type ChatSelectionGuard = Readonly<{
  target: ChatTarget;
  selectionEpoch: number;
}>;

type ChatRequestStartResult =
  | Readonly<{
    kind: "started";
    response: Promise<Response>;
  }>
  | Readonly<{
    kind: "preflight_rejected";
    error: Error;
  }>;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const RFC_CHAT_UUID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;

export const isCanonicalChatUuid = (value: string): boolean =>
  value === value.toLowerCase()
  && RFC_CHAT_UUID_PATTERN.test(value);

export const assertCanonicalChatTurnId = (turnId: string): void => {
  if (!isCanonicalChatUuid(turnId)) {
    throw new Error(
      `Client chat turn identity was not a canonical lowercase UUID: turnId=${turnId}`,
    );
  }
};

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number"
  && Number.isInteger(value)
  && value >= 0;

const isNullableNonNegativeInteger = (
  value: unknown,
): value is number | null =>
  value === null || isNonNegativeInteger(value);

const isValidStreamPosition = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.itemId === "string"
    && value.itemId.trim() !== ""
    && (
      value.responseIndex === undefined
      || isNonNegativeInteger(value.responseIndex)
    )
    && isNonNegativeInteger(value.outputIndex)
    && isNullableNonNegativeInteger(value.contentIndex)
    && isNullableNonNegativeInteger(value.sequenceNumber);
};

const hasValidOptionalStreamPosition = (
  value: Readonly<Record<string, unknown>>,
): boolean =>
  value.streamPosition === undefined
  || isValidStreamPosition(value.streamPosition);

const isValidChatSnapshotContentPart = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string"
        && hasValidOptionalStreamPosition(value);
    case "image":
      return typeof value.mediaType === "string"
        && typeof value.base64Data === "string";
    case "file":
      return typeof value.mediaType === "string"
        && typeof value.base64Data === "string"
        && typeof value.fileName === "string";
    case "tool_call":
      return (value.id === undefined || typeof value.id === "string")
        && typeof value.name === "string"
        && (value.status === "started" || value.status === "completed")
        && (
          value.providerStatus === undefined
          || value.providerStatus === null
          || typeof value.providerStatus === "string"
        )
        && (value.input === null || typeof value.input === "string")
        && (value.output === null || typeof value.output === "string")
        && hasValidOptionalStreamPosition(value);
    case "reasoning_summary":
      return typeof value.summary === "string"
        && isValidStreamPosition(value.streamPosition);
    default:
      return false;
  }
};

export class ChatSessionSnapshotSchemaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatSessionSnapshotSchemaError";
  }
}

export function assertValidChatSessionSnapshot(
  snapshot: unknown,
): asserts snapshot is ChatSessionSnapshot {
  if (!isRecord(snapshot)) {
    throw new ChatSessionSnapshotSchemaError(
      "Chat session snapshot was not an object",
    );
  }
  if (
    typeof snapshot.sessionId !== "string"
    || snapshot.sessionId.trim() === ""
  ) {
    throw new ChatSessionSnapshotSchemaError(
      "Chat session snapshot did not include a sessionId",
    );
  }
  if (
    snapshot.runState !== "idle"
    && snapshot.runState !== "running"
    && snapshot.runState !== "interrupted"
  ) {
    throw new ChatSessionSnapshotSchemaError(
      `Chat session snapshot included an invalid runState: sessionId=${snapshot.sessionId}, runState=${String(snapshot.runState)}`,
    );
  }
  if (
    snapshot.activeTurnId !== null
    && (
      typeof snapshot.activeTurnId !== "string"
      || !isCanonicalChatUuid(snapshot.activeTurnId)
    )
  ) {
    throw new ChatSessionSnapshotSchemaError(
      `Chat session snapshot included an invalid activeTurnId: sessionId=${snapshot.sessionId}, activeTurnId=${String(snapshot.activeTurnId)}`,
    );
  }
  if (
    (snapshot.runState === "running") !== (snapshot.activeTurnId !== null)
  ) {
    throw new ChatSessionSnapshotSchemaError(
      `Chat session snapshot run state did not match active turn identity: sessionId=${snapshot.sessionId}, runState=${snapshot.runState}, activeTurnId=${snapshot.activeTurnId ?? "none"}`,
    );
  }
  if (
    typeof snapshot.updatedAt !== "number"
    || !Number.isFinite(snapshot.updatedAt)
    || typeof snapshot.mainContentInvalidationVersion !== "number"
    || !Number.isFinite(snapshot.mainContentInvalidationVersion)
    || !Array.isArray(snapshot.messages)
  ) {
    throw new ChatSessionSnapshotSchemaError(
      `Chat session snapshot included invalid metadata: sessionId=${snapshot.sessionId}`,
    );
  }

  for (
    const [messageIndex, message] of snapshot.messages.entries()
  ) {
    if (
      !isRecord(message)
      || typeof message.messageId !== "string"
      || !isCanonicalChatUuid(message.messageId)
    ) {
      throw new ChatSessionSnapshotSchemaError(
        `Chat session snapshot included an invalid message identity: sessionId=${snapshot.sessionId}, messageIndex=${String(messageIndex)}`,
      );
    }
    if (
      (message.role !== "user" && message.role !== "assistant")
      || !Array.isArray(message.content)
      || !message.content.every(isValidChatSnapshotContentPart)
      || typeof message.timestamp !== "number"
      || !Number.isFinite(message.timestamp)
      || typeof message.isError !== "boolean"
      || typeof message.isStopped !== "boolean"
    ) {
      throw new ChatSessionSnapshotSchemaError(
        `Chat session snapshot included an invalid persisted message: sessionId=${snapshot.sessionId}, messageId=${message.messageId}`,
      );
    }
  }
}

const startChatRequest = (
  input: RequestInfo | URL,
  init: RequestInit,
): ChatRequestStartResult => {
  try {
    return {
      kind: "started",
      response: fetchWithCsrf(input, init),
    };
  } catch (error) {
    return {
      kind: "preflight_rejected",
      error: toError(error),
    };
  }
};

type ChatOperationOwner = Readonly<{
  ownerId: symbol;
}>;

type ChatSingleFlightRunner<
  Owner extends ChatOperationOwner,
  Result,
> = Readonly<{
  run: (owner: Owner) => Promise<Result>;
  cancel: (owner: Owner) => void;
  cancelActive: () => void;
}>;

export type ChatSendReconciliationRunner<
  Owner extends ChatSendReconciliationOwner,
> = ChatSingleFlightRunner<Owner, void>;

export type ChatTurnCancellationResolution =
  | Readonly<{
    kind: "confirmed";
    response: ExactTurnStopChatSessionResponse;
  }>
  | Readonly<{
    kind: "superseded";
  }>;

export type ChatTurnCancellationRunner<
  Owner extends ChatSendReconciliationOwner,
> = ChatSingleFlightRunner<Owner, ChatTurnCancellationResolution>;

export const isChatSendReconciliationOwnerCurrent = (
  owner: ChatSendReconciliationOwner,
  currentOwner: ChatSendReconciliationOwner | null,
  currentSessionId: string | null,
): boolean =>
  currentOwner?.ownerId === owner.ownerId
  && currentSessionId === owner.sessionId;

export const isChatTurnOwnerForSession = (
  owner: ChatSendReconciliationOwner | null,
  sessionId: string | null,
): boolean =>
  owner !== null
  && owner.sessionId === sessionId;

export const isChatStopOperationOwnerCurrent = (
  owner: ChatStopOperationOwner,
  currentOwner: ChatStopOperationOwner | null,
  currentSessionId: string | null,
): boolean =>
  !owner.abortController.signal.aborted
  && currentOwner?.ownerId === owner.ownerId
  && currentSessionId === owner.sessionId;

export const isChatTurnCancellationSettlementOwned = (
  cancellation: ChatSendReconciliationOwner,
  currentCancellation: ChatSendReconciliationOwner | null,
  currentExactTurn: ChatSendReconciliationOwner | null,
  currentSessionId: string | null,
): boolean =>
  isChatSendReconciliationOwnerCurrent(
    cancellation,
    currentCancellation,
    currentSessionId,
  )
  && currentExactTurn?.ownerId === cancellation.ownerId;

const createSingleFlightChatRunner = <
  Owner extends ChatOperationOwner,
  Result,
>(
  runCycle: (
    owner: Owner,
    abortController: AbortController,
  ) => Promise<Result>,
): ChatSingleFlightRunner<Owner, Result> => {
  let activeCycle: Readonly<{
    ownerId: symbol;
    abortController: AbortController;
    promise: Promise<Result>;
  }> | null = null;

  const run = (owner: Owner): Promise<Result> => {
    if (activeCycle?.ownerId === owner.ownerId) {
      return activeCycle.promise;
    }

    activeCycle?.abortController.abort();
    const abortController = new AbortController();
    let cyclePromise: Promise<Result>;
    cyclePromise = runCycle(owner, abortController).finally((): void => {
      if (activeCycle?.promise === cyclePromise) {
        activeCycle = null;
      }
    });
    activeCycle = {
      ownerId: owner.ownerId,
      abortController,
      promise: cyclePromise,
    };
    return cyclePromise;
  };

  const cancel = (owner: Owner): void => {
    if (activeCycle?.ownerId === owner.ownerId) {
      activeCycle.abortController.abort();
    }
  };

  const cancelActive = (): void => {
    activeCycle?.abortController.abort();
  };

  return {
    run,
    cancel,
    cancelActive,
  };
};

export const createSingleFlightChatSendReconciliationRunner = <
  Owner extends ChatSendReconciliationOwner,
>(
  reconcile: (
    owner: Owner,
    abortController: AbortController,
  ) => Promise<void>,
): ChatSendReconciliationRunner<Owner> =>
  createSingleFlightChatRunner(reconcile);

export const createSingleFlightChatTurnCancellationRunner = <
  Owner extends ChatSendReconciliationOwner,
>(
  reconcile: (
    owner: Owner,
    abortController: AbortController,
  ) => Promise<ChatTurnCancellationResolution>,
): ChatTurnCancellationRunner<Owner> =>
  createSingleFlightChatRunner(reconcile);

export type ChatTurnCancellationRequestErrorKind =
  | "acceptance_unknown"
  | "rejected";

export class ChatTurnCancellationRequestError extends Error {
  public readonly status: number | null;
  public readonly kind: ChatTurnCancellationRequestErrorKind;

  public constructor(
    message: string,
    status: number | null,
    kind: ChatTurnCancellationRequestErrorKind,
  ) {
    super(message);
    this.name = "ChatTurnCancellationRequestError";
    this.status = status;
    this.kind = kind;
  }
}

export const shouldRestoreChatTurnAfterCancellationRejection = (
  error: unknown,
  rejectedTurn: ChatSendReconciliationOwner,
  currentTurn: ChatSendReconciliationOwner | null,
  currentSessionId: string | null,
): boolean =>
  error instanceof ChatTurnCancellationRequestError
  && error.kind === "rejected"
  && isChatSendReconciliationOwnerCurrent(
    rejectedTurn,
    currentTurn,
    currentSessionId,
  );

export const shouldRestoreChatRunAfterSnapshotFailure = (
  stoppedTurn: ChatSendReconciliationOwner,
  activeTurn: ChatSendReconciliationOwner | null,
  currentSessionId: string | null,
): boolean =>
  currentSessionId === stoppedTurn.sessionId
  && activeTurn?.sessionId === stoppedTurn.sessionId
  && activeTurn.turnId === stoppedTurn.turnId;

export type ChatPendingTurnRetryOwner =
  ChatSendReconciliationOwner & Readonly<{
    requestBody: string;
    retryAbortController: AbortController;
  }>;

export const restorePendingChatTurnAfterCancellationRejection = <
  Owner extends ChatPendingTurnRetryOwner,
>(
  error: unknown,
  rejectedTurn: ChatSendReconciliationOwner,
  currentTurn: Owner | null,
  currentSessionId: string | null,
): Owner | null => {
  if (
    currentTurn === null
    || !currentTurn.retryAbortController.signal.aborted
    || !shouldRestoreChatTurnAfterCancellationRejection(
      error,
      rejectedTurn,
      currentTurn,
      currentSessionId,
    )
  ) {
    return null;
  }

  return {
    ...currentTurn,
    retryAbortController: new AbortController(),
  };
};

export type ReconcileChatTurnCancellationParams = Readonly<{
  signal: AbortSignal;
  isOwnerCurrent: () => boolean;
  requestCancellation: (
    signal: AbortSignal,
  ) => Promise<ExactTurnStopChatSessionResponse>;
  waitForRetry: (signal: AbortSignal) => Promise<void>;
}>;

export const reconcileChatTurnCancellation = async (
  params: ReconcileChatTurnCancellationParams,
): Promise<ChatTurnCancellationResolution> => {
  while (!params.signal.aborted && params.isOwnerCurrent()) {
    try {
      const response = await params.requestCancellation(params.signal);
      return params.signal.aborted || !params.isOwnerCurrent()
        ? { kind: "superseded" }
        : {
          kind: "confirmed",
          response,
        };
    } catch (error) {
      if (params.signal.aborted || !params.isOwnerCurrent()) {
        return { kind: "superseded" };
      }
      if (
        error instanceof ChatTurnCancellationRequestError
        && error.kind === "rejected"
      ) {
        throw error;
      }
      await params.waitForRetry(params.signal);
    }
  }

  return { kind: "superseded" };
};

export type CompleteChatTurnCancellationParams =
  ReconcileChatTurnCancellationParams & Readonly<{
    clearCancellationAttempt: () => void;
    clearExactTurnOwnership: () => void;
  }>;

export const completeChatTurnCancellation = async (
  params: CompleteChatTurnCancellationParams,
): Promise<ChatTurnCancellationResolution> => {
  let resolution: ChatTurnCancellationResolution;
  try {
    resolution = await reconcileChatTurnCancellation(params);
  } catch (error) {
    if (
      error instanceof ChatTurnCancellationRequestError
      && error.kind === "rejected"
      && params.isOwnerCurrent()
    ) {
      params.clearCancellationAttempt();
    }
    throw error;
  }

  if (resolution.kind !== "confirmed" || !params.isOwnerCurrent()) {
    params.clearCancellationAttempt();
    return { kind: "superseded" };
  }

  params.clearExactTurnOwnership();
  params.clearCancellationAttempt();
  return resolution;
};

export type ChatConfirmedStopSnapshotResolution<Snapshot> =
  | Readonly<{
    kind: "settled";
    snapshot: Snapshot;
  }>
  | Readonly<{
    kind: "superseded";
    snapshot: Snapshot | null;
  }>;

export type ChatConfirmedStopSnapshotDisposition =
  | "retry"
  | "settled"
  | "superseded";

export type ChatConfirmedStopSnapshotFailureDisposition =
  | "retry"
  | "fail";

export type ReconcileConfirmedChatStopSnapshotParams<Snapshot> = Readonly<{
  signal: AbortSignal;
  isOwnerCurrent: () => boolean;
  loadSnapshot: (signal: AbortSignal) => Promise<Snapshot | null>;
  resolveSnapshot: (
    snapshot: Snapshot,
  ) => ChatConfirmedStopSnapshotDisposition;
  classifyFailure: (
    error: unknown,
  ) => ChatConfirmedStopSnapshotFailureDisposition;
  waitForRetry: (signal: AbortSignal) => Promise<void>;
}>;

export const reconcileConfirmedChatStopSnapshot = async <Snapshot>(
  params: ReconcileConfirmedChatStopSnapshotParams<Snapshot>,
): Promise<ChatConfirmedStopSnapshotResolution<Snapshot>> => {
  while (!params.signal.aborted && params.isOwnerCurrent()) {
    let snapshot: Snapshot | null;
    try {
      snapshot = await params.loadSnapshot(params.signal);
    } catch (error) {
      if (params.signal.aborted || !params.isOwnerCurrent()) {
        return {
          kind: "superseded",
          snapshot: null,
        };
      }
      if (params.classifyFailure(error) === "fail") {
        throw error;
      }
      await params.waitForRetry(params.signal);
      continue;
    }

    if (params.signal.aborted || !params.isOwnerCurrent()) {
      return {
        kind: "superseded",
        snapshot: null,
      };
    }
    if (snapshot === null) {
      await params.waitForRetry(params.signal);
      continue;
    }
    const disposition = params.resolveSnapshot(snapshot);
    if (disposition === "settled") {
      return {
        kind: "settled",
        snapshot,
      };
    }
    if (disposition === "superseded") {
      return {
        kind: "superseded",
        snapshot,
      };
    }
    await params.waitForRetry(params.signal);
  }

  return {
    kind: "superseded",
    snapshot: null,
  };
};

export const resolveConfirmedChatStopSnapshotDisposition = (
  turnId: string | null,
  snapshot: Pick<ChatSessionSnapshot, "activeTurnId" | "runState">,
): ChatConfirmedStopSnapshotDisposition => {
  if (
    snapshot.runState !== "idle"
    && snapshot.runState !== "running"
    && snapshot.runState !== "interrupted"
  ) {
    throw new Error(
      `Chat snapshot included an invalid runState while settling Stop: turnId=${turnId ?? "none"}, runState=${String(snapshot.runState)}`,
    );
  }
  if (snapshot.runState === "running") {
    if (snapshot.activeTurnId === null) {
      throw new Error(
        `Running chat snapshot did not include an activeTurnId while settling Stop: turnId=${turnId ?? "none"}`,
      );
    }
    return turnId !== null && snapshot.activeTurnId !== turnId
      ? "superseded"
      : "retry";
  }
  if (snapshot.activeTurnId !== null) {
    throw new Error(
      `Terminal chat snapshot retained an activeTurnId while settling Stop: turnId=${turnId ?? "none"}, activeTurnId=${snapshot.activeTurnId}`,
    );
  }

  return "settled";
};

export const isDefinitiveChatRequestRejection = (
  result: StreamChatResponseResult,
): boolean =>
  result.failureStage === "request"
  && result.requestAcceptance === "rejected";

export type ChatSendReconciliationDisposition =
  | "preserve_success"
  | "acceptance_unknown";

export const resolveChatSendReconciliationDisposition = (
  turnId: string,
  snapshot: Pick<ChatSessionSnapshot, "messages">,
): ChatSendReconciliationDisposition =>
  snapshot.messages.some((message) => message.messageId === turnId)
    ? "preserve_success"
    : "acceptance_unknown";

export type ChatExactTurnOwnership = Readonly<{
  pendingTurn: ChatSendReconciliationOwner | null;
  activeTurn: ChatSendReconciliationOwner | null;
}>;

export const resolveChatExactTurnOwnership = (
  snapshot: ChatSessionSnapshot,
  pendingTurn: ChatSendReconciliationOwner | null,
  activeTurn: ChatSendReconciliationOwner | null,
  cancellation: ChatSendReconciliationOwner | null,
): ChatExactTurnOwnership => {
  let nextPendingTurn = pendingTurn;
  let nextActiveTurn = activeTurn;
  const pendingTurnWasAccepted = pendingTurn !== null
    && pendingTurn.sessionId === snapshot.sessionId
    && resolveChatSendReconciliationDisposition(
      pendingTurn.turnId,
      snapshot,
    ) === "preserve_success";

  if (pendingTurnWasAccepted && pendingTurn !== null) {
    if (
      (
        snapshot.runState === "running"
        && snapshot.activeTurnId === pendingTurn.turnId
      )
      || cancellation?.ownerId === pendingTurn.ownerId
    ) {
      nextActiveTurn = pendingTurn;
    }
    nextPendingTurn = null;
  }

  if (snapshot.runState === "running") {
    if (snapshot.activeTurnId === null) {
      throw new Error(
        `Running chat snapshot did not include an activeTurnId: sessionId=${snapshot.sessionId}`,
      );
    }
    if (
      nextActiveTurn?.sessionId !== snapshot.sessionId
      || nextActiveTurn.turnId !== snapshot.activeTurnId
    ) {
      nextActiveTurn = {
        ownerId: Symbol(snapshot.activeTurnId),
        sessionId: snapshot.sessionId,
        turnId: snapshot.activeTurnId,
      };
    }
  } else if (
    nextActiveTurn?.sessionId === snapshot.sessionId
    && cancellation?.ownerId !== nextActiveTurn.ownerId
  ) {
    nextActiveTurn = null;
  }

  return {
    pendingTurn: nextPendingTurn,
    activeTurn: nextActiveTurn,
  };
};

export const buildFailedChatSendHistory = (
  authoritativeMessages: ReadonlyArray<StoredMessage>,
  submittedContent: ReadonlyArray<ContentPart>,
  errorMessage: string,
  timestamp: number,
): ReadonlyArray<StoredMessage> => [
  ...authoritativeMessages,
  {
    role: "user",
    content: submittedContent,
    timestamp,
    isError: false,
    isStopped: false,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: errorMessage }],
    timestamp,
    isError: true,
    isStopped: false,
  },
];

export const buildPendingChatSendHistory = (
  authoritativeMessages: ReadonlyArray<StoredMessage>,
  submittedContent: ReadonlyArray<ContentPart>,
  timestamp: number,
): ReadonlyArray<StoredMessage> => [
  ...authoritativeMessages,
  {
    role: "user",
    content: submittedContent,
    timestamp,
    isError: false,
    isStopped: false,
  },
  {
    role: "assistant",
    content: [],
    timestamp,
    isError: false,
    isStopped: false,
  },
];

export const buildStoppedChatSendHistory = (
  authoritativeMessages: ReadonlyArray<StoredMessage>,
  submittedContent: ReadonlyArray<ContentPart>,
  timestamp: number,
): ReadonlyArray<StoredMessage> => [
  ...authoritativeMessages,
  {
    role: "user",
    content: submittedContent,
    timestamp,
    isError: false,
    isStopped: false,
  },
  {
    role: "assistant",
    content: [],
    timestamp,
    isError: false,
    isStopped: true,
  },
];

export type PendingChatTurnTranscript = Readonly<{
  authoritativeMessages: ReadonlyArray<StoredMessage>;
  submittedContent: ReadonlyArray<ContentPart>;
  turnId: string;
}>;

export const resolveConfirmedChatTurnStopHistory = (
  snapshot: Pick<
    ChatSessionSnapshot,
    "activeTurnId" | "messages" | "runState"
  >,
  pendingTurn: PendingChatTurnTranscript,
  timestamp: number,
): ReadonlyArray<StoredMessage> | null => {
  if (
    snapshot.runState === "running"
    || snapshot.activeTurnId !== null
    || resolveChatSendReconciliationDisposition(
      pendingTurn.turnId,
      snapshot,
    ) === "preserve_success"
  ) {
    return null;
  }

  return buildStoppedChatSendHistory(
    snapshot.messages,
    pendingTurn.submittedContent,
    timestamp,
  );
};

const IMAGE_MEDIA_TYPES = new Set<string>(OPENAI_IMAGE_MIME_TYPES);
const HEIC_SIGNATURE_PREFIX_BASE64_CHARACTERS = 16;

const MAX_BODY_BYTES = 90 * 1024 * 1024;
const STREAM_TIMEOUT_MS = 6 * 60 * 1000;

const resolveRejectedChatRequestAcceptance = (
  response: Response,
): Exclude<ChatRequestAcceptance, "accepted"> => {
  if (response.status >= 500) {
    return "unknown";
  }

  return "rejected";
};

const decodeBase64Prefix = (base64Data: string): Uint8Array => {
  const binary = atob(base64Data.slice(0, HEIC_SIGNATURE_PREFIX_BASE64_CHARACTERS));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const isRawHeicAttachment = (attachment: PendingAttachment): boolean =>
  normalizeHeicImageMimeType(attachment.mediaType) !== null
  || isHeicFileExtension(attachment.fileName)
  || hasHeicFileSignature(decodeBase64Prefix(attachment.base64Data));

const buildContentParts = (
  text: string,
  attachments: ReadonlyArray<PendingAttachment>,
): ReadonlyArray<ContentPart> => {
  const parts: Array<ContentPart> = [];

  for (const attachment of attachments) {
    if (IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
      parts.push({
        type: "image",
        mediaType: attachment.mediaType,
        base64Data: attachment.base64Data,
      });
      continue;
    }

    parts.push({
      type: "file",
      mediaType: attachment.mediaType,
      base64Data: attachment.base64Data,
      fileName: attachment.fileName,
    });
  }

  if (text.trim().length > 0) {
    parts.push({
      type: "text",
      text: text.trim(),
    });
  }

  return parts;
};

export const sanitizeChatRouteErrorText = (
  status: number,
  raw: string,
  t: ChatTranslation,
): string => {
  if (raw.trim().length === 0 && status === 500) {
    return t("chat.errorTooLarge", { sizeMb: "?", limitMb: "?" });
  }

  if (raw.includes("<html") || raw.includes("<!DOCTYPE")) {
    const titleMatch = raw.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch !== null) {
      return titleMatch[1];
    }

    return t("chat.errorBlocked");
  }

  return raw;
};

export const prepareChatSendRequest = (
  text: string,
  attachments: ReadonlyArray<PendingAttachment>,
  t: ChatTranslation,
): PreparedChatSendRequest => {
  const rawHeicAttachment = attachments.find(isRawHeicAttachment);
  if (rawHeicAttachment !== undefined) {
    return {
      kind: "invalid_attachment",
      errorMessage: t("chat.attachmentConversionFailed", {
        fileName: rawHeicAttachment.fileName,
        reason: t("chat.attachmentFailureInvalidFormat"),
      }),
    };
  }

  const contentParts = buildContentParts(text, attachments);
  if (contentParts.length === 0) {
    return { kind: "empty" };
  }

  const requestBody = JSON.stringify({
    sessionId: "session-size-check",
    turnId: "00000000-0000-4000-8000-000000000000",
    model: CHAT_MODEL_ID,
    content: contentParts,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } satisfies ExistingChatSendRequestBody);

  if (requestBody.length > MAX_BODY_BYTES) {
    const sizeMb = (requestBody.length / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_BODY_BYTES / (1024 * 1024)).toFixed(0);
    return {
      kind: "too_large",
      contentParts,
      errorMessage: t("chat.errorTooLarge", { sizeMb, limitMb }),
    };
  }

  return {
    kind: "ready",
    contentParts,
  };
};

export const buildChatSendRequestBody = (
  content: ReadonlyArray<ContentPart>,
  sessionId: string,
  turnId: string,
): string =>
  JSON.stringify({
    sessionId,
    turnId,
    model: CHAT_MODEL_ID,
    content,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } satisfies ExistingChatSendRequestBody);

export const buildFreshChatSendRequestBody = (
  content: ReadonlyArray<ContentPart>,
): string =>
  JSON.stringify({
    model: CHAT_MODEL_ID,
    content,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } satisfies ChatMessageRequestBody);

export const createChatSendTransport = (
  target: ChatTarget,
  content: ReadonlyArray<ContentPart>,
  turnId: string,
): ChatSendTransport =>
  target.kind === "draft"
    ? {
      url: "/api/chat/new",
      requestBody: buildFreshChatSendRequestBody(content),
    }
    : {
      url: "/api/chat",
      requestBody: buildChatSendRequestBody(
        content,
        target.sessionId,
        turnId,
      ),
    };

export type ChatSessionSnapshotRequestErrorKind =
  | "not_found"
  | "forbidden"
  | "active_response_conflict"
  | "workspace_reload_required"
  | "other";

export type ChatSnapshotFailureDisposition =
  | "recover_unavailable"
  | "retry_active_response"
  | "block_workspace_reload"
  | "fail";

export const CHAT_SESSION_SYNC_TRANSIENT_RETRY_LIMIT = 1;

export type ChatSessionSyncRefreshCoordinator = Readonly<{
  isRefreshInFlight: boolean;
  hasPendingRefresh: boolean;
}>;

type CleanupChatSessionSyncEffectParams = Readonly<{
  unsubscribe: () => void;
  clearRetryTimeout: () => void;
  abortActiveRequest: () => void;
  reportError: (error: Error) => void;
}>;

export type ChatSessionSyncFailureDisposition =
  | Exclude<ChatSnapshotFailureDisposition, "fail">
  | "retry_transient"
  | "surface_transient"
  | "surface_failure";

export type ChatSnapshotRequestToken = Readonly<{
  sessionId: string;
  selectionEpoch: number;
  generation: number;
}>;

export type ChatSnapshotRequestResult = Readonly<{
  request: ChatSnapshotRequestToken;
  snapshot: Promise<ChatSessionSnapshot>;
}>;

export type ChatSnapshotRequestResolution =
  | Readonly<{
    kind: "current";
    snapshot: ChatSessionSnapshot;
  }>
  | Readonly<{
    kind: "superseded";
    snapshot: ChatSessionSnapshot | null;
  }>;

export type ChatSnapshotRequestCoordinator = Readonly<{
  lastGeneration: number;
  latestRequest: ChatSnapshotRequestToken | null;
  latestResult: ChatSnapshotRequestResult | null;
}>;

export const createChatSnapshotRequestCoordinator =
  (): ChatSnapshotRequestCoordinator => ({
    lastGeneration: 0,
    latestRequest: null,
    latestResult: null,
  });

export const createSingleFlightChatSnapshotPoller = (
  pollSnapshot: () => Promise<void>,
): (() => Promise<void>) => {
  let activePoll: Promise<void> | null = null;

  return (): Promise<void> => {
    if (activePoll !== null) {
      return activePoll;
    }

    activePoll = pollSnapshot().finally((): void => {
      activePoll = null;
    });
    return activePoll;
  };
};

export const beginChatSnapshotRequest = (
  coordinator: ChatSnapshotRequestCoordinator,
  sessionId: string,
  selectionEpoch: number,
  snapshot: Promise<ChatSessionSnapshot>,
): Readonly<{
  coordinator: ChatSnapshotRequestCoordinator;
  request: ChatSnapshotRequestToken;
}> => {
  const request: ChatSnapshotRequestToken = {
    sessionId,
    selectionEpoch,
    generation: coordinator.lastGeneration + 1,
  };
  return {
    coordinator: {
      lastGeneration: request.generation,
      latestRequest: request,
      latestResult: {
        request,
        snapshot,
      },
    },
    request,
  };
};

export const isChatSnapshotRequestCurrent = (
  coordinator: ChatSnapshotRequestCoordinator,
  request: ChatSnapshotRequestToken,
): boolean =>
  coordinator.latestRequest?.sessionId === request.sessionId
  && coordinator.latestRequest.selectionEpoch === request.selectionEpoch
  && coordinator.latestRequest.generation === request.generation;

export const createChatSessionSyncRefreshCoordinator =
  (): ChatSessionSyncRefreshCoordinator => ({
    isRefreshInFlight: false,
    hasPendingRefresh: false,
  });

export const cleanupChatSessionSyncEffect = (
  params: CleanupChatSessionSyncEffectParams,
): void => {
  const cleanupErrors: Array<Error> = [];
  try {
    try {
      params.unsubscribe();
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  } finally {
    try {
      params.clearRetryTimeout();
    } catch (error) {
      cleanupErrors.push(toError(error));
    } finally {
      try {
        params.abortActiveRequest();
      } catch (error) {
        cleanupErrors.push(toError(error));
      }
    }
  }
  for (const error of cleanupErrors) {
    params.reportError(error);
  }
};

export const requestChatSessionSyncRefresh = (
  coordinator: ChatSessionSyncRefreshCoordinator,
): Readonly<{
  coordinator: ChatSessionSyncRefreshCoordinator;
  shouldAbortActiveRefresh: boolean;
  shouldStartRefresh: boolean;
}> => {
  if (!coordinator.isRefreshInFlight) {
    return {
      coordinator: {
        isRefreshInFlight: true,
        hasPendingRefresh: false,
      },
      shouldAbortActiveRefresh: false,
      shouldStartRefresh: true,
    };
  }
  if (coordinator.hasPendingRefresh) {
    return {
      coordinator,
      shouldAbortActiveRefresh: false,
      shouldStartRefresh: false,
    };
  }
  return {
    coordinator: {
      isRefreshInFlight: true,
      hasPendingRefresh: true,
    },
    shouldAbortActiveRefresh: true,
    shouldStartRefresh: false,
  };
};

export const settleChatSessionSyncRefresh = (
  coordinator: ChatSessionSyncRefreshCoordinator,
): Readonly<{
  coordinator: ChatSessionSyncRefreshCoordinator;
  shouldStartPendingRefresh: boolean;
}> =>
  coordinator.hasPendingRefresh
    ? {
      coordinator: {
        isRefreshInFlight: true,
        hasPendingRefresh: false,
      },
      shouldStartPendingRefresh: true,
    }
    : {
      coordinator: createChatSessionSyncRefreshCoordinator(),
      shouldStartPendingRefresh: false,
    };

export const selectSupersedingChatSnapshotRequestResult = (
  coordinator: ChatSnapshotRequestCoordinator,
  request: ChatSnapshotRequestToken,
): ChatSnapshotRequestResult | null =>
  isChatSnapshotRequestCurrent(coordinator, request)
    ? null
    : coordinator.latestResult;

const areChatSnapshotRequestTokensEqual = (
  first: ChatSnapshotRequestToken,
  second: ChatSnapshotRequestToken,
): boolean =>
  first.sessionId === second.sessionId
  && first.selectionEpoch === second.selectionEpoch
  && first.generation === second.generation;

export const resolveChatSnapshotRequest = async (
  getCoordinator: () => ChatSnapshotRequestCoordinator,
  initialResult: ChatSnapshotRequestResult,
): Promise<ChatSnapshotRequestResolution> => {
  let candidate = initialResult;

  while (true) {
    let snapshot: ChatSessionSnapshot;
    try {
      snapshot = await candidate.snapshot;
    } catch (error) {
      const coordinator = getCoordinator();
      if (isChatSnapshotRequestCurrent(coordinator, candidate.request)) {
        if (areChatSnapshotRequestTokensEqual(
          candidate.request,
          initialResult.request,
        )) {
          throw error;
        }
        return {
          kind: "superseded",
          snapshot: null,
        };
      }

      const supersedingResult = selectSupersedingChatSnapshotRequestResult(
        coordinator,
        candidate.request,
      );
      if (supersedingResult === null) {
        return {
          kind: "superseded",
          snapshot: null,
        };
      }
      candidate = supersedingResult;
      continue;
    }

    const coordinator = getCoordinator();
    if (isChatSnapshotRequestCurrent(coordinator, candidate.request)) {
      return areChatSnapshotRequestTokensEqual(
        candidate.request,
        initialResult.request,
      )
        ? {
          kind: "current",
          snapshot,
        }
        : {
          kind: "superseded",
          snapshot,
        };
    }

    const supersedingResult = selectSupersedingChatSnapshotRequestResult(
      coordinator,
      candidate.request,
    );
    if (supersedingResult === null) {
      return {
        kind: "superseded",
        snapshot: null,
      };
    }
    candidate = supersedingResult;
  }
};

const ACTIVE_RESPONSE_CONFLICT_MESSAGE =
  "Chat session already has an active response";
const WORKSPACE_RELOAD_MESSAGE =
  "Active workspace is unavailable. Reload to re-establish workspace context.";

const classifyChatSessionSnapshotRequestError = (
  status: number,
  rawError: string,
): ChatSessionSnapshotRequestErrorKind => {
  if (status === 404) {
    return "not_found";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status !== 409) {
    return "other";
  }

  const message = rawError.trim();
  if (message === ACTIVE_RESPONSE_CONFLICT_MESSAGE) {
    return "active_response_conflict";
  }
  if (message === WORKSPACE_RELOAD_MESSAGE) {
    return "workspace_reload_required";
  }
  return "other";
};

export class ChatSessionSnapshotRequestError extends Error {
  public readonly status: number;
  public readonly kind: ChatSessionSnapshotRequestErrorKind;

  public constructor(
    status: number,
    message: string,
    kind: ChatSessionSnapshotRequestErrorKind,
  ) {
    super(message);
    this.name = "ChatSessionSnapshotRequestError";
    this.status = status;
    this.kind = kind;
  }
}

export type ChatSessionSnapshotTransportErrorKind =
  | "network"
  | "preflight_rejected";

export class ChatSessionSnapshotTransportError extends Error {
  public readonly kind: ChatSessionSnapshotTransportErrorKind;

  public constructor(
    message: string,
    kind: ChatSessionSnapshotTransportErrorKind,
  ) {
    super(message);
    this.name = "ChatSessionSnapshotTransportError";
    this.kind = kind;
  }
}

export const classifyConfirmedChatStopSnapshotFailure = (
  error: unknown,
): ChatConfirmedStopSnapshotFailureDisposition => {
  if (error instanceof ChatSessionSnapshotTransportError) {
    return error.kind === "network" ? "retry" : "fail";
  }
  if (error instanceof ChatSessionSnapshotRequestError) {
    return error.status >= 500
      || error.kind === "active_response_conflict"
      ? "retry"
      : "fail";
  }

  return "fail";
};

export const resolveDefinitiveChatSendSnapshotFailureHistory = (
  error: unknown,
  pendingTurn: ChatSendReconciliationOwner & PendingChatTurnTranscript,
  currentPendingTurn: ChatSendReconciliationOwner | null,
  currentSessionId: string | null,
  errorMessage: string,
  timestamp: number,
): ReadonlyArray<StoredMessage> | null => {
  if (
    classifyConfirmedChatStopSnapshotFailure(error) !== "fail"
    || !isChatSendReconciliationOwnerCurrent(
      pendingTurn,
      currentPendingTurn,
      currentSessionId,
    )
  ) {
    return null;
  }

  return buildFailedChatSendHistory(
    pendingTurn.authoritativeMessages,
    pendingTurn.submittedContent,
    errorMessage,
    timestamp,
  );
};

export const isUnavailableChatSessionSnapshotError = (
  error: unknown,
): error is ChatSessionSnapshotRequestError =>
  error instanceof ChatSessionSnapshotRequestError
  && (
    error.kind === "not_found"
    || error.kind === "forbidden"
  );

export const resolveChatSnapshotFailureDisposition = (
  error: unknown,
): ChatSnapshotFailureDisposition => {
  if (!(error instanceof ChatSessionSnapshotRequestError)) {
    return "fail";
  }

  switch (error.kind) {
    case "not_found":
    case "forbidden":
      return "recover_unavailable";
    case "active_response_conflict":
      return "retry_active_response";
    case "workspace_reload_required":
      return "block_workspace_reload";
    case "other":
      return "fail";
  }
};

const isTransientChatSessionSyncFailure = (error: unknown): boolean =>
  (
    error instanceof ChatSessionSnapshotTransportError
    && error.kind === "network"
  )
  || (
    error instanceof ChatSessionSnapshotRequestError
    && error.status >= 500
  );

export const resolveChatSessionSyncFailureDisposition = (
  error: unknown,
  transientRetryAttempt: number,
): ChatSessionSyncFailureDisposition => {
  if (
    !Number.isSafeInteger(transientRetryAttempt)
    || transientRetryAttempt < 0
  ) {
    throw new Error(
      "Chat session sync retry attempt must be a non-negative safe integer: "
      + `attempt=${String(transientRetryAttempt)}`,
    );
  }
  const disposition = resolveChatSnapshotFailureDisposition(error);
  if (disposition !== "fail") {
    return disposition;
  }
  if (!isTransientChatSessionSyncFailure(error)) {
    return "surface_failure";
  }
  return transientRetryAttempt < CHAT_SESSION_SYNC_TRANSIENT_RETRY_LIMIT
    ? "retry_transient"
    : "surface_transient";
};

export const fetchChatSessionSnapshot = async (
  sessionId: string,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<ChatSessionSnapshot> => {
  const url = `/api/chat?sessionId=${encodeURIComponent(sessionId)}`;
  const request = startChatRequest(url, {
    method: "GET",
    signal,
  });
  if (request.kind === "preflight_rejected") {
    throw new ChatSessionSnapshotTransportError(
      `Chat snapshot request was rejected before sending: sessionId=${sessionId}, error=${request.error.message}`,
      "preflight_rejected",
    );
  }

  let response: Response;
  try {
    response = await request.response;
  } catch (error) {
    const requestError = toError(error);
    throw new ChatSessionSnapshotTransportError(
      `Chat snapshot request failed before receiving a response: sessionId=${sessionId}, error=${requestError.message}`,
      "network",
    );
  }

  if (!response.ok) {
    let rawError: string;
    try {
      rawError = await response.text();
    } catch (error) {
      const statusText = response.statusText.trim() === ""
        ? "Snapshot request failed"
        : response.statusText;
      const readFailure = toError(error);
      throw new ChatSessionSnapshotRequestError(
        response.status,
        `Error ${String(response.status)}: ${statusText}; response body could not be read: ${readFailure.message}`,
        classifyChatSessionSnapshotRequestError(response.status, ""),
      );
    }
    throw new ChatSessionSnapshotRequestError(
      response.status,
      `Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, t)}`,
      classifyChatSessionSnapshotRequestError(response.status, rawError),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    const readFailure = toError(error);
    if (error instanceof SyntaxError) {
      throw new ChatSessionSnapshotSchemaError(
        `Chat snapshot response contained malformed JSON: sessionId=${sessionId}, error=${readFailure.message}`,
      );
    }
    throw new ChatSessionSnapshotTransportError(
      `Chat snapshot response body could not be read: sessionId=${sessionId}, error=${readFailure.message}`,
      "network",
    );
  }
  assertValidChatSessionSnapshot(payload);
  if (payload.sessionId !== sessionId) {
    throw new ChatSessionSnapshotSchemaError(
      `Chat snapshot response session did not match the requested session: requestedSessionId=${sessionId}, returnedSessionId=${payload.sessionId}`,
    );
  }
  return payload;
};

const isStopChatSessionResponse = (
  payload: unknown,
  sessionId: string,
  turnId: string | null,
): payload is StopChatSessionResponse => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }

  const candidate = payload as Readonly<Record<string, unknown>>;
  if (
    candidate.ok !== true
    || candidate.sessionId !== sessionId
    || typeof candidate.stopped !== "boolean"
    || typeof candidate.stillRunning !== "boolean"
  ) {
    return false;
  }

  return turnId === null
    || (
      candidate.turnId === turnId
      && candidate.cancellationConfirmed === true
    );
};

export function postStopChatSession(
  sessionId: string,
  turnId: string,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<ExactTurnStopChatSessionResponse>;
export function postStopChatSession(
  sessionId: string,
  turnId: null,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<SessionLevelStopChatSessionResponse>;
export function postStopChatSession(
  sessionId: string,
  turnId: string | null,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<StopChatSessionResponse>;
export async function postStopChatSession(
  sessionId: string,
  turnId: string | null,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<StopChatSessionResponse> {
  const request = startChatRequest("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ...(turnId === null ? {} : { turnId }),
    }),
    signal,
  });
  if (request.kind === "preflight_rejected") {
    throw new ChatTurnCancellationRequestError(
      `Chat stop request was rejected before sending: sessionId=${sessionId}, turnId=${turnId ?? "none"}, error=${request.error.message}`,
      null,
      "rejected",
    );
  }
  const response = await request.response;

  if (!response.ok) {
    const kind: ChatTurnCancellationRequestErrorKind =
      response.status >= 500 ? "acceptance_unknown" : "rejected";
    let rawError: string;
    try {
      rawError = await response.text();
    } catch (error) {
      const statusText = response.statusText.trim() === ""
        ? (kind === "rejected" ? "Request rejected" : "Server error")
        : response.statusText;
      const readFailure = error instanceof Error
        ? error.message
        : String(error);
      throw new ChatTurnCancellationRequestError(
        `Error ${String(response.status)}: ${statusText}; response body could not be read: ${readFailure}`,
        response.status,
        kind,
      );
    }
    throw new ChatTurnCancellationRequestError(
      `Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, t)}`,
      response.status,
      kind,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChatTurnCancellationRequestError(
      `Chat stop confirmation could not be read: sessionId=${sessionId}, turnId=${turnId ?? "none"}, status=${String(response.status)}, error=${message}`,
      response.status,
      "acceptance_unknown",
    );
  }
  if (!isStopChatSessionResponse(payload, sessionId, turnId)) {
    throw new ChatTurnCancellationRequestError(
      `Chat stop returned an invalid confirmation: sessionId=${sessionId}, turnId=${turnId ?? "none"}`,
      response.status,
      "acceptance_unknown",
    );
  }
  return payload;
}

export const isChatSelectionGuardCurrent = (
  guard: ChatSelectionGuard,
  target: ChatTarget,
  selectionEpoch: number,
): boolean =>
  guard.selectionEpoch === selectionEpoch
  && areChatTargetsEqual(guard.target, target);

export const resolveSelectedChatSessionGuard = (
  sessionId: string,
  target: ChatTarget,
  selectionEpoch: number,
): ChatSelectionGuard | null =>
  target.kind === "session" && target.sessionId === sessionId
    ? {
      target,
      selectionEpoch,
    }
    : null;

export const shouldAbortChatStreamForSelectionEpoch = (
  streamSelectionEpoch: number,
  nextSelectionEpoch: number,
): boolean =>
  streamSelectionEpoch !== nextSelectionEpoch;

export const shouldAbortChatStreamForSelectionChange = (
  streamSelectionEpoch: number,
  nextSelectionEpoch: number,
  unadoptedDraftId: string | null,
): boolean =>
  unadoptedDraftId === null
  && shouldAbortChatStreamForSelectionEpoch(
    streamSelectionEpoch,
    nextSelectionEpoch,
  );

export const shouldAbortChatStreamForControllerCleanup = (
  unadoptedDraftId: string | null,
): boolean =>
  unadoptedDraftId === null;

export const isChatStreamControllerOwnedByStop = (
  stopStreamController: AbortController | null,
  activeStreamController: AbortController | null,
): boolean =>
  stopStreamController !== null
  && stopStreamController === activeStreamController;

export const isChatStopSettlementOwned = (
  stoppedSessionId: string,
  currentSessionId: string | null,
  stopStreamController: AbortController | null,
  activeStreamController: AbortController | null,
): boolean =>
  stoppedSessionId === currentSessionId
  && (
    stopStreamController === null
      ? activeStreamController === null
      : isChatStreamControllerOwnedByStop(
        stopStreamController,
        activeStreamController,
      )
  );

const readStreamChunkWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  abortStream: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortStream();
      reject(new Error("No response from AI model — please try again"));
    }, STREAM_TIMEOUT_MS);

    signal.addEventListener("abort", () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }, { once: true });
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
};

export const streamChatResponse = async (
  params: StreamChatResponseParams,
): Promise<StreamChatResponseResult> => {
  let responseSessionId: string | null = null;
  let streamFailure: Error | null = null;
  let failureStage: StreamChatFailureStage = null;
  let receivedContent = false;
  let requestAcceptance: ChatRequestAcceptance = "unknown";

  const request = startChatRequest(params.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params.requestBody,
    signal: params.signal,
  });
  if (request.kind === "preflight_rejected") {
    return {
      responseSessionId: null,
      streamFailure: request.error,
      failureStage: "request",
      receivedContent: false,
      wasAborted: params.signal.aborted,
      requestAcceptance: "rejected",
    };
  }

  try {
    const response = await request.response;

    if (!response.ok) {
      requestAcceptance = resolveRejectedChatRequestAcceptance(response);
      const rawError = await response.text();
      return {
        responseSessionId: null,
        streamFailure: new Error(`Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, params.t)}`),
        failureStage: "request",
        receivedContent: false,
        wasAborted: false,
        requestAcceptance,
      };
    }

    requestAcceptance = "accepted";
    responseSessionId = response.headers.get("X-Chat-Session-Id");
    if (responseSessionId !== null && responseSessionId.length > 0) {
      params.onSessionIdReceived(responseSessionId);
    } else {
      responseSessionId = null;
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      return {
        responseSessionId,
        streamFailure: new Error(params.t("chat.errorNoResponse")),
        failureStage: "request",
        receivedContent: false,
        wasAborted: false,
        requestAcceptance,
      };
    }

    params.onLiveStreamConnected();

    const decoder = new TextDecoder();
    let buffer = "";
    let reachedTerminalState = false;

    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(
        reader,
        params.signal,
        params.abortStream,
      );
      if (done) {
        break;
      }

      const drainedChunk = drainChatStreamChunk({
        buffer,
        chunk: decoder.decode(value, { stream: true }),
      });
      buffer = drainedChunk.buffer;

      for (const event of drainedChunk.events) {
        const transportResult = applyChatStreamEvent(event, params.handlers);

        if (transportResult.receivedContent) {
          receivedContent = true;
        }

        if (transportResult.reachedTerminalState) {
          reachedTerminalState = true;
          break;
        }
      }

      if (reachedTerminalState) {
        break;
      }
    }

    if (!receivedContent) {
      streamFailure = new Error(params.t("chat.errorEmptyResponse"));
      failureStage = "stream";
    }
  } catch (error) {
    if (!params.signal.aborted) {
      streamFailure = error instanceof Error ? error : new Error(String(error));
      failureStage = requestAcceptance === "accepted" ? "stream" : "request";
    }
  }

  return {
    responseSessionId,
    streamFailure,
    failureStage,
    receivedContent,
    wasAborted: params.signal.aborted,
    requestAcceptance,
  };
};
