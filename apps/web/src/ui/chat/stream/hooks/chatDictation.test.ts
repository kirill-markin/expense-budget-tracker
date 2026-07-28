import assert from "node:assert/strict";
import test from "node:test";
import {
  getNextChatDictationOperationEpoch,
  isChatDictationOperationCurrent,
  sanitizeChatTranscriptionErrorText,
  transcribeChatAudio,
} from "./chatDictation";

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}>;

const createDeferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve): void => {
    resolvePromise = resolve;
  });
  if (resolvePromise === null) {
    throw new Error("Failed to create deferred chat dictation test promise");
  }

  return {
    promise,
    resolve: resolvePromise,
  };
};

const t = (key: string): string => {
  if (key === "chat.dictationFailed") {
    return "Audio transcription failed. Please try again.";
  }

  throw new Error(`Unexpected translation key: ${key}`);
};

test("sanitizeChatTranscriptionErrorText hides HTML edge responses", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "<html><head><title>403 Forbidden</title></head><body>blocked</body></html>",
    "text/html",
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText hides HTML edge fragments", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "<h1>403 Forbidden</h1>",
    null,
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText hides text/html edge responses without tags", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "403 Forbidden",
    "text/html; charset=utf-8",
    t,
  );

  assert.equal(sanitizedMessage, "Audio transcription failed. Please try again.");
});

test("sanitizeChatTranscriptionErrorText preserves plain route errors", (): void => {
  const sanitizedMessage = sanitizeChatTranscriptionErrorText(
    "Unsupported audio file type. Use m4a, wav, or webm.",
    "text/plain",
    t,
  );

  assert.equal(sanitizedMessage, "Unsupported audio file type. Use m4a, wav, or webm.");
});

test("a delayed permission continuation is stale after a target switch", async (): Promise<void> => {
  let currentEpoch = getNextChatDictationOperationEpoch(0);
  const firstOperationEpoch = currentEpoch;
  const permission = createDeferred<string>();
  const isContinuationCurrent = permission.promise.then(
    (): boolean => isChatDictationOperationCurrent(
      firstOperationEpoch,
      currentEpoch,
    ),
  );

  currentEpoch = getNextChatDictationOperationEpoch(currentEpoch);
  permission.resolve("granted");

  assert.equal(await isContinuationCurrent, false);
});

test("a delayed transcription cannot overwrite a newer operation", async (): Promise<void> => {
  let currentEpoch = getNextChatDictationOperationEpoch(0);
  const firstOperationEpoch = currentEpoch;
  const transcription = createDeferred<string>();
  let selectedDraftText = "newer target";
  const applyTranscription = transcription.promise.then((text): void => {
    if (isChatDictationOperationCurrent(firstOperationEpoch, currentEpoch)) {
      selectedDraftText = text;
    }
  });

  currentEpoch = getNextChatDictationOperationEpoch(currentEpoch);
  transcription.resolve("stale transcript");
  await applyTranscription;

  assert.equal(selectedDraftText, "newer target");
});

test("transcribeChatAudio sends audio without creating or naming a chat session", async (): Promise<void> => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const submittedForms: Array<FormData> = [];

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
      assert.ok(init.body instanceof FormData);
      submittedForms.push(init.body);
      return Response.json({ text: "hello" });
    },
  });

  try {
    const result = await transcribeChatAudio(
      new Blob(["audio"], { type: "audio/webm" }),
      t,
    );

    assert.deepEqual(result, { text: "hello" });
    assert.equal(submittedForms[0]?.get("sessionId"), null);
    assert.equal(submittedForms[0]?.get("source"), "web");
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", originalDocument);
    }
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  }
});
