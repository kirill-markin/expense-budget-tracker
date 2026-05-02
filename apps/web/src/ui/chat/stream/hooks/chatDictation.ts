"use client";

import { fetchWithCsrf } from "@/lib/csrf";

type ChatTranslation = (key: string) => string;

export type ChatDictationState = "idle" | "requesting_permission" | "recording" | "transcribing";

export type ChatDraftSelection = Readonly<{
  start: number;
  end: number;
}>;

export type ChatDraftInsertionResult = Readonly<{
  text: string;
  selection: ChatDraftSelection;
}>;

const isWhitespaceCharacter = (value: string | undefined): boolean =>
  value !== undefined && /\s/.test(value);

const normalizeSelection = (
  draft: string,
  selection: ChatDraftSelection | null,
): ChatDraftSelection => {
  const draftLength = draft.length;
  if (selection === null) {
    return {
      start: draftLength,
      end: draftLength,
    };
  }

  const start = Math.max(0, Math.min(selection.start, draftLength));
  const end = Math.max(0, Math.min(selection.end, draftLength));
  return start <= end
    ? { start, end }
    : { start: end, end: start };
};

export const insertDictationTranscriptIntoDraft = (
  draft: string,
  transcript: string,
  selection: ChatDraftSelection | null,
): ChatDraftInsertionResult => {
  const trimmedTranscript = transcript.trim();
  const normalizedSelection = normalizeSelection(draft, selection);
  if (trimmedTranscript === "") {
    return {
      text: draft,
      selection: normalizedSelection,
    };
  }

  const before = draft.slice(0, normalizedSelection.start);
  const after = draft.slice(normalizedSelection.end);
  const prefix = before === "" || isWhitespaceCharacter(before.at(-1)) ? "" : " ";
  const suffix = after === "" || isWhitespaceCharacter(after[0]) ? "" : " ";
  const insertedText = `${prefix}${trimmedTranscript}${suffix}`;
  const text = `${before}${insertedText}${after}`;
  const caret = before.length + insertedText.length;

  return {
    text,
    selection: {
      start: caret,
      end: caret,
    },
  };
};

const extensionForAudioMediaType = (mediaType: string): string => {
  if (mediaType === "audio/wav" || mediaType === "audio/wave" || mediaType === "audio/x-wav") {
    return "wav";
  }

  if (mediaType === "audio/mp4" || mediaType === "audio/m4a" || mediaType === "audio/x-m4a") {
    return "m4a";
  }

  return "webm";
};

const normalizeAudioMediaType = (mediaType: string): string => {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  const [baseMediaType] = normalizedMediaType.split(";", 1);

  if (baseMediaType === "audio/wav" || baseMediaType === "audio/wave" || baseMediaType === "audio/x-wav") {
    return "audio/wav";
  }

  if (baseMediaType === "audio/mp4" || baseMediaType === "audio/m4a" || baseMediaType === "audio/x-m4a") {
    return "audio/mp4";
  }

  return "audio/webm";
};

type ChatTranscriptionResponse = Readonly<{
  text: string;
  sessionId: string;
}>;

const isHtmlContentType = (contentType: string | null): boolean => {
  if (contentType === null) {
    return false;
  }

  const normalizedContentType = contentType.trim().toLowerCase();
  return normalizedContentType === "text/html" || normalizedContentType.startsWith("text/html;");
};

const isHtmlLikeErrorText = (raw: string): boolean => {
  const normalizedRaw = raw.trim().toLowerCase();
  return (
    normalizedRaw === ""
    || normalizedRaw.includes("<html")
    || normalizedRaw.includes("<!doctype")
    || normalizedRaw.startsWith("<!--")
    || /^<\/?[a-z][a-z0-9-]*(?:\s|>|\/>)/.test(normalizedRaw)
  );
};

export const sanitizeChatTranscriptionErrorText = (
  raw: string,
  contentType: string | null,
  t: ChatTranslation,
): string => {
  if (isHtmlContentType(contentType) || isHtmlLikeErrorText(raw)) {
    return t("chat.dictationFailed");
  }

  return raw;
};

export const transcribeChatAudio = async (
  blob: Blob,
  sessionId: string,
  t: ChatTranslation,
): Promise<ChatTranscriptionResponse> => {
  const mediaType = normalizeAudioMediaType(blob.type === "" ? "audio/webm" : blob.type);
  const file = new File([blob], `chat-dictation.${extensionForAudioMediaType(mediaType)}`, {
    type: mediaType,
  });
  const formData = new FormData();
  formData.append("file", file);
  formData.append("source", "web");
  formData.append("sessionId", sessionId);

  const response = await fetchWithCsrf("/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(sanitizeChatTranscriptionErrorText(
      message,
      response.headers.get("content-type"),
      t,
    ));
  }

  const payload = await response.json() as ChatTranscriptionResponse;
  if (typeof payload.text !== "string" || payload.text.trim() === "") {
    throw new Error(t("chat.dictationFailed"));
  }
  if (typeof payload.sessionId !== "string" || payload.sessionId.trim() === "") {
    throw new Error(t("chat.dictationFailed"));
  }

  return payload;
};
