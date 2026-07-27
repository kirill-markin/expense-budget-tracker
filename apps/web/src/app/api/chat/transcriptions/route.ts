import { randomUUID } from "node:crypto";
import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
} from "@/server/chat/transcriptions";
import { ensureUserProvisioned } from "@/server/db";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatTranscriptionRouteResponse =
  | Readonly<{ text: string }>
  | Readonly<{ text: string; sessionId: string }>;

type ChatTranscriptionsRouteDependencies = Readonly<{
  ensureUserProvisioned: typeof ensureUserProvisioned;
  parseChatTranscriptionUpload: typeof parseChatTranscriptionUpload;
  transcribeChatAudioUpload: typeof transcribeChatAudioUpload;
}>;

const DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES: ChatTranscriptionsRouteDependencies = {
  ensureUserProvisioned,
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
};

const assertAuthenticatedChatRequest = (request: Request): void => {
  try {
    extractUserId(request);
    extractWorkspaceId(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiRouteError(401, message);
  }
};

export const transcribeChatRouteWithDeps = async (
  request: Request,
  dependencies: ChatTranscriptionsRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: "/api/chat/transcriptions",
      method: "POST",
      internalErrorMessage: "Chat transcription failed",
    },
    async (): Promise<Response> => {
      assertAuthenticatedChatRequest(request);
      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await dependencies.ensureUserProvisioned(userId, workspaceId);
      const upload = await dependencies.parseChatTranscriptionUpload(request);
      const text = await dependencies.transcribeChatAudioUpload(upload, {
        requestId: randomUUID(),
        userId,
        workspaceId,
        source: upload.source,
        fileName: upload.file.name,
        mediaType: upload.file.type.trim().toLowerCase(),
        fileSize: upload.file.size,
      });
      const responseBody: ChatTranscriptionRouteResponse = upload.sessionId === null
        ? { text }
        : { text, sessionId: upload.sessionId };
      return Response.json(responseBody);
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  transcribeChatRouteWithDeps(request, DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES);
