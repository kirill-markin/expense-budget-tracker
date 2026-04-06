import assert from "node:assert/strict";
import test from "node:test";
import { ApiRouteError } from "@/server/api/errors";
import { parseChatTranscriptionUpload } from "@/server/chat/transcriptions";

const createTranscriptionRequest = (
  formData: FormData,
): Request =>
  new Request("http://localhost/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

test("parseChatTranscriptionUpload requires a session id", async (): Promise<void> => {
  const formData = new FormData();
  formData.append("file", new File(["audio"], "audio.webm", { type: "audio/webm" }));
  formData.append("source", "web");

  await assert.rejects(
    async (): Promise<void> => {
      await parseChatTranscriptionUpload(createTranscriptionRequest(formData));
    },
    (error: unknown) =>
      error instanceof ApiRouteError
      && error.status === 400
      && error.message === "sessionId is required",
  );
});
