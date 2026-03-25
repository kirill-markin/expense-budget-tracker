import assert from "node:assert/strict";
import test from "node:test";
import { ApiRouteError } from "@/server/api/errors";
import {
  parseChatTranscriptionUpload,
  transcribeChatAudioUpload,
} from "./transcriptions";

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
  }, {
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

test("transcribeChatAudioUpload converts invalid audio provider errors into a 422 route error", async () => {
  await assert.rejects(
    () => transcribeChatAudioUpload({
      file: new File([new Uint8Array([1, 2, 3])], "sample.webm", { type: "audio/webm" }),
      source: "web",
    }, {
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
    }, {
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
