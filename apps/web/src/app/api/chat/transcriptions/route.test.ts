import assert from "node:assert/strict";
import test from "node:test";
import { transcribeChatRouteWithDeps } from "@/app/api/chat/transcriptions/route";
import { ChatSessionNotFoundError } from "@/server/chat/store";

const createHeaders = (): Headers =>
  new Headers({
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

const createTranscriptionRequest = (): Request =>
  new Request("http://localhost/api/chat/transcriptions", {
    method: "POST",
    headers: createHeaders(),
  });

test("transcribeChatRouteWithDeps returns 404 for missing sessions", async (): Promise<void> => {
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      getChatSessionSnapshot: async () => {
        throw new ChatSessionNotFoundError("missing");
      },
      parseChatTranscriptionUpload: async () => ({
        file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
        source: "web",
        sessionId: "missing",
      }),
      transcribeChatAudioUpload: async () => {
        throw new Error("should not transcribe");
      },
    },
  );

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Chat session not found: missing");
});
