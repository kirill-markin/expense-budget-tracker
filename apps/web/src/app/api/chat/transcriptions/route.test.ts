import assert from "node:assert/strict";
import test from "node:test";
import { ChatSessionNotFoundError } from "@/server/chat/store";
import type { ChatTranscriptionTelemetryContext } from "@/server/chat/transcriptions";
import { transcribeChatRouteWithDeps } from "./route";

test("transcribeChatRouteWithDeps returns transcript JSON for authenticated requests", async () => {
  let observedTelemetryContext: ChatTranscriptionTelemetryContext | null = null;
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  const response = await transcribeChatRouteWithDeps(request, {
    getChatSessionSnapshot: async (_userId, _workspaceId, sessionId) => ({
      sessionId: sessionId ?? "session-current",
      runState: "idle",
      updatedAt: 1,
      activeRunHeartbeatAt: null,
      mainContentInvalidationVersion: 0,
      messages: [],
    }),
    parseChatTranscriptionUpload: async () => ({
      file: new File([new Uint8Array([1])], "sample.webm", { type: "audio/webm" }),
      source: "web",
      sessionId: "session-current",
    }),
    transcribeChatAudioUpload: async (_upload, telemetryContext: ChatTranscriptionTelemetryContext) => {
      observedTelemetryContext = telemetryContext;
      return "hello world";
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hello world", sessionId: "session-current" });
  assert.notEqual(observedTelemetryContext, null);
  if (observedTelemetryContext === null) {
    throw new Error("Telemetry context was not forwarded");
  }
  const telemetryContext = observedTelemetryContext as ChatTranscriptionTelemetryContext;
  assert.equal(telemetryContext.userId, "user-1");
  assert.equal(telemetryContext.sessionId, "session-current");
  assert.equal(telemetryContext.source, "web");
  assert.equal(telemetryContext.fileName, "sample.webm");
  assert.equal(telemetryContext.mediaType, "audio/webm");
  assert.equal(telemetryContext.fileSize, 1);
  assert.equal(telemetryContext.requestId.length !== 0, true);
});

test("transcribeChatRouteWithDeps repairs stale session IDs to the latest session", async () => {
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  const response = await transcribeChatRouteWithDeps(request, {
    getChatSessionSnapshot: async (_userId, _workspaceId, sessionId) => {
      if (sessionId === "session-stale") {
        throw new ChatSessionNotFoundError(sessionId);
      }

      return {
        sessionId: "session-repaired",
        runState: "idle",
        updatedAt: 1,
        activeRunHeartbeatAt: null,
        mainContentInvalidationVersion: 0,
        messages: [],
      };
    },
    parseChatTranscriptionUpload: async () => ({
      file: new File([new Uint8Array([1])], "sample.webm", { type: "audio/webm" }),
      source: "web",
      sessionId: "session-stale",
    }),
    transcribeChatAudioUpload: async () => "hello world",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hello world", sessionId: "session-repaired" });
});

test("transcribeChatRouteWithDeps rejects unauthenticated requests", async () => {
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
  });

  const response = await transcribeChatRouteWithDeps(request, {
    getChatSessionSnapshot: async () => {
      throw new Error("should not resolve sessions without auth");
    },
    parseChatTranscriptionUpload: async () => {
      throw new Error("should not parse uploads without auth");
    },
    transcribeChatAudioUpload: async () => {
      throw new Error("should not transcribe uploads without auth");
    },
  });

  assert.equal(response.status, 401);
  assert.match(await response.text(), /Missing x-user-id header|Missing x-workspace-id header/);
});
