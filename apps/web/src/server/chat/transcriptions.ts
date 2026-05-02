import { Buffer } from "node:buffer";
import { toFile } from "openai";
import { ApiRouteError } from "@/server/api/errors";
import { getObservedOpenAIClient } from "@/server/chat/openai/client";
import {
  startChatTranscriptionObservation,
  type ChatTranscriptionTraceMetadata,
} from "@/server/chat/openai/langfuse";
import { log } from "@/server/logger";

export type ChatTranscriptionSource = "web";

type OpenAITranscriptionClient = Readonly<{
  audio: Readonly<{
    transcriptions: Readonly<{
      create: (
        body: Readonly<{
          file: File;
          model: "gpt-4o-transcribe";
        }>,
      ) => Promise<Readonly<{ text: string }>>;
    }>;
  }>;
}>;

export type ChatTranscriptionUpload = Readonly<{
  file: File;
  source: ChatTranscriptionSource;
  sessionId: string;
}>;

export type ChatTranscriptionTelemetryContext = ChatTranscriptionTraceMetadata;

type OpenAIErrorMetadata = Readonly<{
  upstreamStatus: number | null;
  upstreamMessage: string | null;
  upstreamRequestId: string | null;
  originalMessage: string;
}>;

const CHAT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const CHAT_TRANSCRIPTION_GENERIC_ERROR_MESSAGE = "Audio transcription failed. Please try again.";
const CHAT_TRANSCRIPTION_INVALID_AUDIO_ERROR_MESSAGE = "We couldn’t process that recording. Please try again.";
export const MAX_CHAT_TRANSCRIPTION_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_AUDIO_FILE_EXTENSIONS = new Set(["m4a", "wav", "webm"]);
const SUPPORTED_AUDIO_MEDIA_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
]);

const getRequiredOpenAIApiKey = (): string => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new ApiRouteError(500, "OPENAI_API_KEY environment variable is not set");
  }

  return apiKey;
};

export const createOpenAITranscriptionClient = (): OpenAITranscriptionClient => {
  getRequiredOpenAIApiKey();
  return getObservedOpenAIClient();
};

const normalizeFileExtension = (fileName: string): string | null => {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex < 0 || extensionIndex === fileName.length - 1) {
    return null;
  }

  return fileName.slice(extensionIndex + 1).toLowerCase();
};

const isSupportedAudioUpload = (file: File): boolean => {
  const normalizedMediaType = file.type.trim().toLowerCase();
  const normalizedExtension = normalizeFileExtension(file.name);

  return SUPPORTED_AUDIO_MEDIA_TYPES.has(normalizedMediaType)
    || (normalizedExtension !== null && SUPPORTED_AUDIO_FILE_EXTENSIONS.has(normalizedExtension));
};

const getFormData = async (request: Request): Promise<FormData> => {
  try {
    return await request.formData();
  } catch {
    throw new ApiRouteError(400, "Invalid multipart form data");
  }
};

export const parseChatTranscriptionUpload = async (request: Request): Promise<ChatTranscriptionUpload> => {
  const formData = await getFormData(request);
  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    throw new ApiRouteError(400, "file is required");
  }

  if (fileValue.size <= 0) {
    throw new ApiRouteError(400, "file must not be empty");
  }

  if (fileValue.size > MAX_CHAT_TRANSCRIPTION_FILE_SIZE_BYTES) {
    const sizeMb = (fileValue.size / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_CHAT_TRANSCRIPTION_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    throw new ApiRouteError(
      400,
      `Audio file is too large (${sizeMb} MB). Maximum allowed size is ${limitMb} MB.`,
    );
  }

  if (!isSupportedAudioUpload(fileValue)) {
    throw new ApiRouteError(400, "Unsupported audio file type. Use m4a, wav, or webm.");
  }

  const sourceValue = formData.get("source");
  if (sourceValue !== "web") {
    throw new ApiRouteError(400, "source must be web");
  }

  return {
    file: fileValue,
    source: sourceValue,
    sessionId: (() => {
      const sessionValue = formData.get("sessionId");
      if (typeof sessionValue !== "string") {
        throw new ApiRouteError(400, "sessionId is required");
      }

      const normalizedSessionId = sessionValue.trim();
      if (normalizedSessionId === "") {
        throw new ApiRouteError(400, "sessionId is required");
      }

      return normalizedSessionId;
    })(),
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getErrorMetadata = (error: unknown): OpenAIErrorMetadata => {
  if (isRecord(error)) {
    const upstreamStatus = typeof error.status === "number" ? error.status : null;
    const upstreamMessage = typeof error.message === "string" && error.message !== ""
      ? error.message
      : null;
    const upstreamRequestId = typeof error.request_id === "string" && error.request_id !== ""
      ? error.request_id
      : null;
    return {
      upstreamStatus,
      upstreamMessage,
      upstreamRequestId,
      originalMessage: upstreamMessage ?? JSON.stringify(error),
    };
  }

  if (error instanceof Error) {
    return {
      upstreamStatus: null,
      upstreamMessage: error.message,
      upstreamRequestId: null,
      originalMessage: error.message,
    };
  }

  return {
    upstreamStatus: null,
    upstreamMessage: null,
    upstreamRequestId: null,
    originalMessage: String(error),
  };
};

const isInvalidAudioMessage = (message: string | null): boolean => {
  if (message === null) {
    return false;
  }

  return /corrupted|unsupported|processing failed|unprocessable/i.test(message);
};

const isInvalidAudioFailure = (error: unknown): boolean => {
  const metadata = getErrorMetadata(error);
  if (metadata.upstreamStatus === null) {
    return false;
  }

  return [400, 415, 422, 500].includes(metadata.upstreamStatus)
    && isInvalidAudioMessage(metadata.upstreamMessage);
};

const logChatTranscriptionFailure = (
  telemetryContext: ChatTranscriptionTelemetryContext,
  upload: ChatTranscriptionUpload,
  metadata: OpenAIErrorMetadata,
): void => {
  log({
    domain: "chat",
    action: "transcription_failed",
    vendor: "openai",
    requestId: telemetryContext.requestId,
    userId: telemetryContext.userId,
    sessionId: telemetryContext.sessionId,
    source: upload.source,
    fileName: upload.file.name,
    fileSize: upload.file.size,
    fileExtension: normalizeFileExtension(upload.file.name),
    mediaType: upload.file.type.trim().toLowerCase(),
    upstreamStatus: metadata.upstreamStatus,
    upstreamMessage: metadata.upstreamMessage,
    upstreamRequestId: metadata.upstreamRequestId,
    error: metadata.originalMessage,
  });
};

const createProviderError = (error: unknown): ApiRouteError => {
  const metadata = getErrorMetadata(error);
  if (metadata.upstreamStatus === 429) {
    return new ApiRouteError(503, "Audio transcription is temporarily overloaded. Please try again.");
  }

  return new ApiRouteError(502, CHAT_TRANSCRIPTION_GENERIC_ERROR_MESSAGE);
};

export const transcribeChatAudioUpload = async (
  upload: ChatTranscriptionUpload,
  telemetryContext: ChatTranscriptionTelemetryContext,
  client?: OpenAITranscriptionClient,
): Promise<string> => {
  try {
    const transcriptionClient = client ?? createOpenAITranscriptionClient();
    return await startChatTranscriptionObservation(telemetryContext, async (): Promise<string> => {
      const buffer = Buffer.from(await upload.file.arrayBuffer());
      const file = await toFile(buffer, upload.file.name, { type: upload.file.type });
      const result = await transcriptionClient.audio.transcriptions.create({
        file,
        model: CHAT_TRANSCRIPTION_MODEL,
      });
      const trimmedText = result.text.trim();
      if (trimmedText === "") {
        throw new Error("Transcription response was empty");
      }

      return trimmedText;
    });
  } catch (error) {
    if (error instanceof ApiRouteError) {
      throw error;
    }

    const metadata = getErrorMetadata(error);
    logChatTranscriptionFailure(telemetryContext, upload, metadata);

    if (isInvalidAudioFailure(error)) {
      throw new ApiRouteError(422, CHAT_TRANSCRIPTION_INVALID_AUDIO_ERROR_MESSAGE);
    }

    throw createProviderError(error);
  }
};
