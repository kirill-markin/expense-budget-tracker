import { handleRoute } from "@/server/api/handleRoute";
import { ApiRouteError } from "@/server/api/errors";
import {
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
} from "@/server/chat/transcriptions";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatTranscriptionsRouteDependencies = Readonly<{
  parseChatTranscriptionUpload: typeof parseChatTranscriptionUpload;
  transcribeChatAudioUpload: typeof transcribeChatAudioUpload;
}>;

const DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES: ChatTranscriptionsRouteDependencies = {
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
      const upload = await dependencies.parseChatTranscriptionUpload(request);
      const text = await dependencies.transcribeChatAudioUpload(upload);
      return Response.json({ text });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  transcribeChatRouteWithDeps(request, DEFAULT_CHAT_TRANSCRIPTIONS_ROUTE_DEPENDENCIES);
