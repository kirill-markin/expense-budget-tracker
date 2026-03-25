import assert from "node:assert/strict";
import test from "node:test";
import { transcribeChatRouteWithDeps } from "./route";

test("transcribeChatRouteWithDeps returns transcript JSON for authenticated requests", async () => {
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  const response = await transcribeChatRouteWithDeps(request, {
    parseChatTranscriptionUpload: async () => ({
      file: new File([new Uint8Array([1])], "sample.webm", { type: "audio/webm" }),
      source: "web",
    }),
    transcribeChatAudioUpload: async () => "hello world",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hello world" });
});

test("transcribeChatRouteWithDeps rejects unauthenticated requests", async () => {
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
  });

  const response = await transcribeChatRouteWithDeps(request, {
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

