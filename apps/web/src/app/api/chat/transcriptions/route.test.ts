import assert from "node:assert/strict";
import test from "node:test";

import { transcribeChatRouteWithDeps } from "@/app/api/chat/transcriptions/route";
import type { ChatTranscriptionTelemetryContext } from "@/server/chat/transcriptions";
import { WorkspaceAccessError } from "@/server/workspaceErrors";

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

test("transcription succeeds without a persisted chat session", async (): Promise<void> => {
  const telemetryContexts: Array<ChatTranscriptionTelemetryContext> = [];
  const membershipChecks: Array<Readonly<{
    userId: string;
    workspaceId: string;
  }>> = [];
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      ensureUserProvisioned: async (userId, workspaceId) => {
        membershipChecks.push({ userId, workspaceId });
      },
      parseChatTranscriptionUpload: async () => ({
        file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
        source: "web",
        sessionId: null,
      }),
      transcribeChatAudioUpload: async (_upload, context) => {
        telemetryContexts.push(context);
        return "transcribed text";
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "transcribed text" });
  assert.deepEqual(membershipChecks, [{
    userId: "user-1",
    workspaceId: "workspace-1",
  }]);
  assert.equal(telemetryContexts[0]?.userId, "user-1");
  assert.equal(telemetryContexts[0]?.workspaceId, "workspace-1");
  assert.equal(telemetryContexts[0]?.sessionId, null);
  assert.equal(typeof telemetryContexts[0]?.requestId, "string");
});

test("transcription echoes a valid legacy client session id", async (): Promise<void> => {
  const telemetryContexts: Array<ChatTranscriptionTelemetryContext> = [];
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      ensureUserProvisioned: async () => undefined,
      parseChatTranscriptionUpload: async () => ({
        file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
        source: "web",
        sessionId: "session-legacy",
      }),
      transcribeChatAudioUpload: async (_upload, context) => {
        telemetryContexts.push(context);
        return "legacy transcription";
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "legacy transcription",
    sessionId: "session-legacy",
  });
  assert.equal(telemetryContexts[0]?.sessionId, "session-legacy");
});

test("transcription accepts and propagates a 200-character session id", async (): Promise<void> => {
  const sessionId = "s".repeat(200);
  const telemetryContexts: Array<ChatTranscriptionTelemetryContext> = [];
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      ensureUserProvisioned: async () => undefined,
      parseChatTranscriptionUpload: async () => ({
        file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
        source: "web",
        sessionId,
      }),
      transcribeChatAudioUpload: async (_upload, context) => {
        telemetryContexts.push(context);
        return "limit transcription";
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "limit transcription",
    sessionId,
  });
  assert.equal(telemetryContexts[0]?.sessionId, sessionId);
});

test("transcription rejects session ids longer than the Langfuse limit", async (): Promise<void> => {
  let providerCalled = false;
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      ensureUserProvisioned: async () => undefined,
      parseChatTranscriptionUpload: async () => ({
        file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
        source: "web",
        sessionId: "s".repeat(201),
      }),
      transcribeChatAudioUpload: async () => {
        providerCalled = true;
        return "must not transcribe";
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(
    await response.text(),
    "sessionId must contain at most 200 characters for audio transcription",
  );
  assert.equal(providerCalled, false);
});

test("transcription still rejects missing workspace authentication", async (): Promise<void> => {
  const response = await transcribeChatRouteWithDeps(
    new Request("http://localhost/api/chat/transcriptions", {
      method: "POST",
      headers: new Headers({ "x-user-id": "user-1" }),
    }),
    {
      ensureUserProvisioned: async () => {
        throw new Error("should not validate membership");
      },
      parseChatTranscriptionUpload: async () => {
        throw new Error("should not parse");
      },
      transcribeChatAudioUpload: async () => {
        throw new Error("should not transcribe");
      },
    },
  );

  assert.equal(response.status, 401);
});

test("transcription rejects inaccessible workspaces before parsing or provider use", async (): Promise<void> => {
  let uploadParsed = false;
  let providerCalled = false;
  const response = await transcribeChatRouteWithDeps(
    createTranscriptionRequest(),
    {
      ensureUserProvisioned: async (userId, workspaceId) => {
        throw new WorkspaceAccessError(userId, workspaceId);
      },
      parseChatTranscriptionUpload: async () => {
        uploadParsed = true;
        return {
          file: new File(["audio"], "audio.webm", { type: "audio/webm" }),
          source: "web",
          sessionId: null,
        };
      },
      transcribeChatAudioUpload: async () => {
        providerCalled = true;
        return "must not transcribe";
      },
    },
  );

  assert.equal(response.status, 409);
  assert.equal(uploadParsed, false);
  assert.equal(providerCalled, false);
});
