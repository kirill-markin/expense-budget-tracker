import assert from "node:assert/strict";
import test from "node:test";
import { ApiRouteError } from "@/server/api/errors";
import { getObservedOpenAIClient } from "@/server/chat/openai/client";
import {
  createOpenAITranscriptionClient,
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
} from "./transcriptions";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

const createTelemetryContext = () => ({
  requestId: "req-1",
  userId: "user-1",
  sessionId: "session-1",
  source: "web" as const,
  fileName: "sample.webm",
  mediaType: "audio/webm",
  fileSize: 3,
});

test.afterEach(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
    return;
  }

  process.env.OPENAI_API_KEY = originalOpenAiApiKey;
});

test("parseChatTranscriptionUpload accepts supported webm uploads", async () => {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1, 2, 3])], "sample.webm", {
    type: "audio/webm",
  }));
  formData.append("source", "web");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  const upload = await parseChatTranscriptionUpload(request);
  assert.equal(upload.file.name, "sample.webm");
  assert.equal(upload.source, "web");
  assert.equal(upload.sessionId, undefined);
});

test("parseChatTranscriptionUpload accepts optional session IDs", async () => {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1, 2, 3])], "sample.webm", {
    type: "audio/webm",
  }));
  formData.append("source", "web");
  formData.append("sessionId", "session-1");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  const upload = await parseChatTranscriptionUpload(request);
  assert.equal(upload.sessionId, "session-1");
});

test("parseChatTranscriptionUpload accepts supported wav uploads", async () => {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1, 2, 3])], "sample.wav", {
    type: "audio/wav",
  }));
  formData.append("source", "web");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  const upload = await parseChatTranscriptionUpload(request);
  assert.equal(upload.file.name, "sample.wav");
  assert.equal(upload.source, "web");
});

test("parseChatTranscriptionUpload accepts supported m4a uploads", async () => {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1, 2, 3])], "sample.m4a", {
    type: "audio/mp4",
  }));
  formData.append("source", "web");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  const upload = await parseChatTranscriptionUpload(request);
  assert.equal(upload.file.name, "sample.m4a");
  assert.equal(upload.source, "web");
});

test("parseChatTranscriptionUpload rejects unsupported audio types", async () => {
  const formData = new FormData();
  formData.append("file", new File([new Uint8Array([1])], "sample.mp3", {
    type: "audio/mpeg",
  }));
  formData.append("source", "web");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  await assert.rejects(
    () => parseChatTranscriptionUpload(request),
    (error: unknown) => error instanceof ApiRouteError
      && error.status === 400
      && error.publicMessage === "Unsupported audio file type. Use m4a, wav, or webm.",
  );
});

test("parseChatTranscriptionUpload rejects empty files", async () => {
  const formData = new FormData();
  formData.append("file", new File([], "sample.webm", { type: "audio/webm" }));
  formData.append("source", "web");

  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    body: formData,
  });

  await assert.rejects(
    () => parseChatTranscriptionUpload(request),
    (error: unknown) => error instanceof ApiRouteError
      && error.status === 400
      && error.publicMessage === "file must not be empty",
  );
});

test("parseChatTranscriptionUpload rejects invalid multipart form data", async () => {
  const request = new Request("https://app.example.com/api/chat/transcriptions", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=bad-boundary",
    },
    body: "--bad-boundary\r\ninvalid\r\n--bad-boundary--",
  });

  await assert.rejects(
    () => parseChatTranscriptionUpload(request),
    (error: unknown) => error instanceof ApiRouteError
      && error.status === 400
      && error.publicMessage === "Invalid multipart form data",
  );
});

test("transcribeChatAudioUpload returns trimmed transcript text", async () => {
  const transcript = await transcribeChatAudioUpload({
    file: new File([new Uint8Array([1, 2, 3])], "sample.webm", { type: "audio/webm" }),
    source: "web",
  }, createTelemetryContext(), {
    audio: {
      transcriptions: {
        create: async (): Promise<Readonly<{ text: string }>> => ({
          text: "  hello world  ",
        }),
      },
    },
  });

  assert.equal(transcript, "hello world");
});

test("createOpenAITranscriptionClient reuses the observed OpenAI client", () => {
  process.env.OPENAI_API_KEY = "test-key";

  assert.equal(createOpenAITranscriptionClient(), getObservedOpenAIClient());
});

test("transcribeChatAudioUpload converts invalid audio provider errors into a 422 route error", async () => {
  await assert.rejects(
    () => transcribeChatAudioUpload({
      file: new File([new Uint8Array([1, 2, 3])], "sample.webm", { type: "audio/webm" }),
      source: "web",
    }, createTelemetryContext(), {
      audio: {
        transcriptions: {
          create: async (): Promise<Readonly<{ text: string }>> => {
            throw Object.assign(new Error("Unsupported audio format"), {
              status: 422,
              request_id: "upstream-1",
            });
          },
        },
      },
    }),
    (error: unknown) => error instanceof ApiRouteError
      && error.status === 422
      && error.publicMessage === "We couldn’t process that recording. Please try again.",
  );
});

test("transcribeChatAudioUpload converts generic provider failures into a 502 route error", async () => {
  await assert.rejects(
    () => transcribeChatAudioUpload({
      file: new File([new Uint8Array([1, 2, 3])], "sample.webm", { type: "audio/webm" }),
      source: "web",
    }, createTelemetryContext(), {
      audio: {
        transcriptions: {
          create: async (): Promise<Readonly<{ text: string }>> => {
            throw Object.assign(new Error("Internal provider failure"), {
              status: 500,
              request_id: "upstream-2",
            });
          },
        },
      },
    }),
    (error: unknown) => error instanceof ApiRouteError
      && error.status === 502
      && error.publicMessage === "Audio transcription failed. Please try again.",
  );
});
