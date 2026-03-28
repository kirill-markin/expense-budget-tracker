import { randomUUID } from "node:crypto";
import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  ChatSessionNotFoundError,
  getChatSessionSnapshot,
} from "@/server/chat/store";
import {
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
} from "@/server/chat/transcriptions";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatTranscriptionRouteResponse = Readonly<{
  text: string;
  sessionId: string;
}>;

type ChatTranscriptionsRouteDependencies = Readonly<{
  getChatSessionSnapshot: typeof getChatSessionSnapshot;
  parseChatTranscriptionUpload: typeof parseChatTranscriptionUpload;
  transcribeChatAudioUpload: typeof transcribeChatAudioUpload;
}>;

const DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES: ChatTranscriptionsRouteDependencies = {
  getChatSessionSnapshot,
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

const resolveTranscriptionSessionId = async (
  userId: string,
  workspaceId: string,
  requestedSessionId: string | undefined,
  dependencies: ChatTranscriptionsRouteDependencies,
): Promise<string> => {
  try {
    return await dependencies.getChatSessionSnapshot(userId, workspaceId, requestedSessionId)
      .then((snapshot) => snapshot.sessionId);
  } catch (error) {
    if (requestedSessionId !== undefined && error instanceof ChatSessionNotFoundError) {
      return dependencies.getChatSessionSnapshot(userId, workspaceId)
        .then((snapshot) => snapshot.sessionId);
    }

    throw error;
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
      const upload = await dependencies.parseChatTranscriptionUpload(request);
      const sessionId = await resolveTranscriptionSessionId(
        userId,
        workspaceId,
        upload.sessionId,
        dependencies,
      );
      const text = await dependencies.transcribeChatAudioUpload(upload, {
        requestId: randomUUID(),
        userId,
        sessionId,
        source: upload.source,
        fileName: upload.file.name,
        mediaType: upload.file.type.trim().toLowerCase(),
        fileSize: upload.file.size,
      });
      return Response.json({
        text,
        sessionId,
      } satisfies ChatTranscriptionRouteResponse);
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  transcribeChatRouteWithDeps(request, DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES);
