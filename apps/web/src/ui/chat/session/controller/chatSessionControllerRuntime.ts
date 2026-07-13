"use client";

import { fetchWithCsrf } from "@/lib/csrf";
import {
  hasHeicFileSignature,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  OPENAI_IMAGE_MIME_TYPES,
} from "@/lib/chatImageFormats";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { ContentPart } from "@/server/chat/types";
import type { PendingAttachment } from "../../shell/panel/FileAttachment";
import type { ChatSessionSnapshot } from "../bootstrap/chatSessionSnapshot";
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

type ChatClearConversationResponse = Readonly<{
  ok: boolean;
  sessionId: string;
}>;

type ChatSendRequestBody = Readonly<{
  sessionId: string;
  model: string;
  content: ReadonlyArray<ContentPart>;
  timezone: string;
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
  requestBody: string;
  signal: AbortSignal;
  abortStream: () => void;
  t: ChatTranslation;
  handlers: ChatStreamTransportHandlers;
  onSessionIdReceived: (sessionId: string) => void;
  onLiveStreamConnected: () => void;
}>;

export type StreamChatFailureStage = "request" | "stream" | null;

type ChatCreateSessionResponse = Readonly<{
  sessionId: string;
}>;

export type StreamChatResponseResult = Readonly<{
  responseSessionId: string | null;
  streamFailure: Error | null;
  failureStage: StreamChatFailureStage;
  receivedContent: boolean;
  wasAborted: boolean;
}>;

const IMAGE_MEDIA_TYPES = new Set<string>(OPENAI_IMAGE_MIME_TYPES);
const HEIC_SIGNATURE_PREFIX_BASE64_CHARACTERS = 16;

const MAX_BODY_BYTES = 90 * 1024 * 1024;
const STREAM_TIMEOUT_MS = 6 * 60 * 1000;

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
    model: CHAT_MODEL_ID,
    content: contentParts,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } satisfies ChatSendRequestBody);

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
): string =>
  JSON.stringify({
    sessionId,
    model: CHAT_MODEL_ID,
    content,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  } satisfies ChatSendRequestBody);

export const fetchChatSessionSnapshot = async (
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  t: ChatTranslation,
): Promise<ChatSessionSnapshot> => {
  const url = sessionId === undefined
    ? "/api/chat"
    : `/api/chat?sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetchWithCsrf(url, {
    method: "GET",
    signal,
  });

  if (!response.ok) {
    const rawError = await response.text();
    throw new Error(`Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, t)}`);
  }

  return response.json() as Promise<ChatSessionSnapshot>;
};

export const postStopChatSession = async (
  sessionId: string,
): Promise<void> => {
  await fetchWithCsrf("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
};

export const createChatSession = async (
  t: ChatTranslation,
): Promise<string> => {
  const response = await fetchWithCsrf("/api/chat/session", {
    method: "POST",
  });

  if (!response.ok) {
    const rawError = await response.text();
    throw new Error(`Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, t)}`);
  }

  const payload = await response.json() as ChatCreateSessionResponse;
  if (typeof payload.sessionId !== "string" || payload.sessionId.trim() === "") {
    throw new Error("Chat session creation failed");
  }

  return payload.sessionId;
};

export const ensureWritableChatSession = async (
  sessionId: string | null,
  createSession: () => Promise<string>,
): Promise<string> => {
  if (sessionId !== null) {
    return sessionId;
  }

  return createSession();
};

export const deleteChatConversation = async (
  sessionId: string | null,
  t: ChatTranslation,
): Promise<ChatClearConversationResponse> => {
  const clearUrl = sessionId === null
    ? "/api/chat"
    : `/api/chat?sessionId=${encodeURIComponent(sessionId)}`;
  const response = await fetchWithCsrf(clearUrl, {
    method: "DELETE",
  });

  if (!response.ok) {
    const rawError = await response.text();
    throw new Error(`Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, t)}`);
  }

  return response.json() as Promise<ChatClearConversationResponse>;
};

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

  try {
    const response = await fetchWithCsrf("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params.requestBody,
      signal: params.signal,
    });

    if (!response.ok) {
      const rawError = await response.text();
      return {
        responseSessionId: null,
        streamFailure: new Error(`Error ${response.status}: ${sanitizeChatRouteErrorText(response.status, rawError, params.t)}`),
        failureStage: "request",
        receivedContent: false,
        wasAborted: false,
      };
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      return {
        responseSessionId: null,
        streamFailure: new Error(params.t("chat.errorNoResponse")),
        failureStage: "request",
        receivedContent: false,
        wasAborted: false,
      };
    }

    responseSessionId = response.headers.get("X-Chat-Session-Id");
    if (responseSessionId !== null && responseSessionId.length > 0) {
      params.onSessionIdReceived(responseSessionId);
    } else {
      responseSessionId = null;
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
      failureStage = "stream";
    }
  }

  return {
    responseSessionId,
    streamFailure,
    failureStage,
    receivedContent,
    wasAborted: params.signal.aborted,
  };
};
