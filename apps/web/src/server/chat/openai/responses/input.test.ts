import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_SENT_INPUT_BUDGET_TOKENS } from "@/lib/chatModels";
import { UnsupportedImageMediaTypeError } from "@/server/chat/attachments/validation";
import {
  buildChatCompletionInput,
  sanitizeContentPartsForTelemetry,
  UnsupportedStoredChatAttachmentError,
} from "@/server/chat/openai/responses/input";
import type {
  ServerChatMessage,
  StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import type { ContentPart } from "@/server/chat/types";
import { EMPTY_CHAT_TURN_FILE_CONTEXT } from "@/server/chatFiles/sessionContext";
import {
  buildChatFileViewReplayItem,
  toPersistedOpenAIReplayItems,
} from "@/server/chat/openai/responses/replayItems";

const HEIC_BASE64_PREFIX = "AAAAGGZ0eXBoZWljAAAAAA==";
const JPEG_BASE64_PREFIX = "/9j/4AAQSkZJRg==";

test("buildChatCompletionInput rejects a legacy HEIC attachment without mutating history", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "image",
      mediaType: "image/heic",
      base64Data: HEIC_BASE64_PREFIX,
    }],
  }];
  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue" }];
  const originalMessages = structuredClone(localMessages);
  const originalTurnInput = structuredClone(turnInput);

  await assert.rejects(
    buildChatCompletionInput(localMessages, turnInput, "Europe/Madrid", "session-1", "req-1", EMPTY_CHAT_TURN_FILE_CONTEXT),
    (error: unknown): boolean => {
      assert.ok(error instanceof UnsupportedStoredChatAttachmentError);
      assert.equal(error.fileName, null);
      assert.equal(error.mediaType, "image/heic");
      assert.match(error.message, /media type "image\/heic"/);
      assert.equal(error.message.includes(HEIC_BASE64_PREFIX), false);
      return true;
    },
  );

  assert.deepEqual(localMessages, originalMessages);
  assert.deepEqual(turnInput, originalTurnInput);
});

test("buildChatCompletionInput replays a prepared JPEG as a native input image", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "image",
      mediaType: "image/jpeg",
      base64Data: JPEG_BASE64_PREFIX,
    }],
  }];

  const { items: input } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "What is in the image?" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  assert.deepEqual(input[1], {
    role: "user",
    type: "message",
    content: [{
      type: "input_image",
      detail: "auto",
      image_url: `data:image/jpeg;base64,${JPEG_BASE64_PREFIX}`,
    }],
  });
});

test("buildChatCompletionInput replays a stored document as the file the sandbox mounts", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "file",
      fileId: "11111111-1111-4111-8111-111111111111",
      path: "/files/statement.csv",
      mediaType: "text/csv",
      sizeBytes: 31,
      sha256: "d".repeat(64),
    }],
  }];

  const { items: input } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  assert.deepEqual(input[1], {
    role: "user",
    type: "message",
    content: [{
      type: "input_text",
      text: "Attached file \"/files/statement.csv\", 31 bytes. "
        + "Read it with the bash tool; this message does not carry its contents.",
    }],
  });
});

test("buildChatCompletionInput keeps current-turn attachment validation distinct", async (): Promise<void> => {
  await assert.rejects(
    buildChatCompletionInput(
      [],
      [{
        type: "image",
        mediaType: "image/heic",
        base64Data: HEIC_BASE64_PREFIX,
      }],
      "Europe/Madrid",
      "session-1",
      "req-1",
      EMPTY_CHAT_TURN_FILE_CONTEXT,
    ),
    UnsupportedImageMediaTypeError,
  );
});

test("buildChatCompletionInput expands logical PDF pages into ordered text and JPEG pairs", async (): Promise<void> => {
  const firstJpeg = "/9j/4AAQSkZJRg==";
  const secondJpeg = "/9j/4AAQSkZJRgE=";
  const pdfPart: Extract<ContentPart, { type: "pdf" }> = {
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "c".repeat(64),
    pages: [
      { pageNumber: 1, text: "2026-08-17 -42.00", jpegBase64Data: firstJpeg },
      { pageNumber: 2, text: "", jpegBase64Data: secondJpeg },
    ],
  };
  const { items: input } = await buildChatCompletionInput(
    [{ role: "user", content: [pdfPart] }],
    [{ type: "text", text: "Continue with this statement" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  assert.equal(input.length, 4);
  const userMessage = input[1];
  assert.equal(userMessage.type, "message");
  if (userMessage.type !== "message" || typeof userMessage.content === "string") {
    assert.fail("Expected a structured user message");
  }
  assert.deepEqual(userMessage.content.map((part) => part.type), [
    "input_text",
    "input_image",
    "input_text",
    "input_image",
  ]);
  assert.match(
    "text" in userMessage.content[0] ? userMessage.content[0].text : "",
    /two representations of the same PDF page/u,
  );
  assert.match(
    "text" in userMessage.content[0] ? userMessage.content[0].text : "",
    /Do not treat them as duplicate transactions/u,
  );
  assert.match(
    "text" in userMessage.content[2] ? userMessage.content[2].text : "",
    /No embedded text was extracted/u,
  );
  assert.deepEqual(userMessage.content[1], {
    type: "input_image",
    detail: "high",
    image_url: `data:image/jpeg;base64,${firstJpeg}`,
  });
  assert.equal(
    userMessage.content.some((part) => part.type === "input_file"),
    false,
  );
});

test("buildChatCompletionInput removes a JSONB-reordered copy of the current logical PDF turn", async (): Promise<void> => {
  const firstJpeg = "/9j/4AAQSkZJRg==";
  const secondJpeg = "/9j/4AAQSkZJRgE=";
  const currentTurn: ReadonlyArray<ContentPart> = [{
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "e".repeat(64),
    pages: [
      { pageNumber: 1, text: "First persisted page", jpegBase64Data: firstJpeg },
      { pageNumber: 2, text: "Second persisted page", jpegBase64Data: secondJpeg },
    ],
  }];
  const canonicalPdf = currentTurn[0];
  if (canonicalPdf?.type !== "pdf") {
    assert.fail("Expected a canonical logical PDF turn");
  }
  const persistedPdf: Extract<ContentPart, { type: "pdf" }> = {
    pages: canonicalPdf.pages.map((page) => ({
      jpegBase64Data: page.jpegBase64Data,
      text: page.text,
      pageNumber: page.pageNumber,
    })),
    sourceSha256: canonicalPdf.sourceSha256,
    mediaType: canonicalPdf.mediaType,
    fileName: canonicalPdf.fileName,
    type: canonicalPdf.type,
  };

  const { items: input } = await buildChatCompletionInput(
    [{ role: "user", content: [persistedPdf] }],
    currentTurn,
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  assert.equal(input.length, 3);
  const userMessage = input[1];
  assert.equal(userMessage.type, "message");
  if (userMessage.type !== "message" || typeof userMessage.content === "string") {
    assert.fail("Expected one structured current-turn user message");
  }
  assert.deepEqual(userMessage.content.map((part) => part.type), [
    "input_text",
    "input_image",
    "input_text",
    "input_image",
  ]);
  assert.equal(
    userMessage.content.filter(
      (part) => part.type === "input_image"
        && part.image_url === `data:image/jpeg;base64,${firstJpeg}`,
    ).length,
    1,
  );
  assert.equal(
    userMessage.content.filter(
      (part) => part.type === "input_image"
        && part.image_url === `data:image/jpeg;base64,${secondJpeg}`,
    ).length,
    1,
  );
  assert.equal(
    userMessage.content.filter(
      (part) => part.type === "input_text"
        && part.text.includes("First persisted page"),
    ).length,
    1,
  );
  assert.equal(
    userMessage.content.filter(
      (part) => part.type === "input_text"
        && part.text.includes("Second persisted page"),
    ).length,
    1,
  );
});

test("buildChatCompletionInput replays a stored session from its newest compaction item", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [
    { role: "user", content: [{ type: "text", text: "First question" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "First answer" }],
      openaiItems: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "First answer", annotations: [] }],
      }],
    },
    { role: "user", content: [{ type: "text", text: "Third question" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Third answer" }],
      openaiItems: [
        {
          type: "function_call",
          call_id: "call-compacted",
          name: "sql_query",
          arguments: "{}",
        },
        {
          type: "compaction",
          id: "compaction-1",
          encrypted_content: "opaque-summary",
        },
        {
          type: "function_call_output",
          call_id: "call-compacted",
          output: "{\"rows\":[]}",
        },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Third answer", annotations: [] }],
        },
      ],
    },
  ];

  const { items: input } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  // The turns ahead of the compaction item are inside its summary, while the
  // tool result stored behind it keeps its own call.
  assert.deepEqual(input.map((item) => item.type), [
    "message",
    "compaction",
    "function_call",
    "function_call_output",
    "message",
    "message",
    "message",
  ]);
  assert.deepEqual(input[1], {
    type: "compaction",
    id: "compaction-1",
    encrypted_content: "opaque-summary",
  });
  assert.equal(JSON.stringify(input).includes("First question"), false);
  assert.equal(JSON.stringify(input).includes("Third question"), false);
});

const LONG_TURN_TEXT_CHARACTERS = 12_000;

/**
 * One stored turn big enough that a few dozen of them pass the sent-input
 * budget, with a marker the assertions can look for in the built input.
 */
const createLongStoredTurn = (
  turnIndex: number,
  assistantItems: ReadonlyArray<StoredOpenAIReplayItem>,
): ReadonlyArray<ServerChatMessage> => [
  {
    role: "user",
    content: [{
      type: "text",
      text: `Turn ${String(turnIndex)} question ${"q".repeat(LONG_TURN_TEXT_CHARACTERS)}`,
    }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: `Turn ${String(turnIndex)} answer` }],
    openaiItems: [
      ...assistantItems,
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: `Turn ${String(turnIndex)} answer ${"a".repeat(LONG_TURN_TEXT_CHARACTERS)}`,
          annotations: [],
        }],
      },
    ],
  },
];

const createLongStoredSession = (
  turnCount: number,
  compactionTurnIndex: number | null,
): ReadonlyArray<ServerChatMessage> =>
  Array.from({ length: turnCount }).flatMap((_, turnIndex) =>
    createLongStoredTurn(
      turnIndex,
      turnIndex === compactionTurnIndex
        ? [{ type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" }]
        : [],
    ));

test("buildChatCompletionInput trims the oldest turns of a session that outgrew the sent-input budget", async (): Promise<void> => {
  const localMessages = createLongStoredSession(40, null);

  const { items: input, replayedMessages } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  // Instructions, then a replayed user turn: an assistant turn whose question
  // was dropped would answer nothing.
  const firstHistoryItem = input[1];
  assert.ok(firstHistoryItem !== undefined && "role" in firstHistoryItem);
  assert.equal(firstHistoryItem.role, "user");
  const serializedInput = JSON.stringify(input);
  assert.equal(serializedInput.includes("Turn 0 question"), false);
  assert.ok(serializedInput.includes(`Turn ${String(localMessages.length / 2 - 1)} answer`));
  assert.ok(replayedMessages < localMessages.length);
  assert.ok(replayedMessages > 0);
});

test("buildChatCompletionInput keeps the newest turn and drops a compaction item the budget no longer accepts", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [
    ...createLongStoredTurn(0, []),
    {
      role: "user",
      content: [{ type: "text", text: "Turn 1 question" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Turn 1 answer" }],
      openaiItems: [
        { type: "compaction", id: "compaction-1", encrypted_content: "opaque-summary" },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            // One turn larger than the whole budget on its own, so no
            // user-aligned cut fits and the compaction item behind it no longer
            // stands for a history that fits either.
            text: "o".repeat(CHAT_SENT_INPUT_BUDGET_TOKENS * 4),
            annotations: [],
          }],
        },
      ],
    },
  ];

  const { items: input } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    EMPTY_CHAT_TURN_FILE_CONTEXT,
  );

  // The newest question and its answer are kept rather than the session being
  // erased, and the stale compaction item is not replayed in the middle of a
  // history that is being sent in full.
  assert.equal(input.some((item) => item.type === "compaction"), false);
  assert.equal(JSON.stringify(input).includes("opaque-summary"), false);
  const firstHistoryItem = input[1];
  assert.ok(firstHistoryItem !== undefined && "role" in firstHistoryItem);
  assert.equal(firstHistoryItem.role, "user");
  const serializedInput = JSON.stringify(input);
  assert.ok(serializedInput.includes("Turn 1 question"));
  assert.equal(serializedInput.includes("Turn 0 question"), false);
});

test("PDF telemetry carries only the source digest and derived page summaries", async (): Promise<void> => {
  const sanitized = await sanitizeContentPartsForTelemetry([{
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "d".repeat(64),
    pages: [{
      pageNumber: 1,
      text: "amount",
      jpegBase64Data: JPEG_BASE64_PREFIX,
    }],
  }]);

  assert.deepEqual(sanitized, [{
    type: "pdf",
    summary: {
      fileName: "statement.pdf",
      mediaType: "application/pdf",
      sizeBytes: Buffer.from(JPEG_BASE64_PREFIX, "base64").byteLength,
      sha256: "d".repeat(64),
      pageCount: 1,
      extractedTextCharacters: 6,
    },
  }]);
  assert.equal(JSON.stringify(sanitized).includes(JPEG_BASE64_PREFIX), false);
});

test("document telemetry carries the stored row's own measurements", async (): Promise<void> => {
  const sanitized = await sanitizeContentPartsForTelemetry([{
    type: "file",
    fileId: "11111111-1111-4111-8111-111111111111",
    path: "/files/statement.csv",
    mediaType: "text/csv",
    sizeBytes: 31,
    sha256: "e".repeat(64),
  }]);

  assert.deepEqual(sanitized, [{
    type: "file",
    summary: {
      fileName: "/files/statement.csv",
      mediaType: "text/csv",
      sizeBytes: 31,
      sha256: "e".repeat(64),
    },
  }]);
});

test("buildChatCompletionInput sends the file listing behind the turn and keeps the clock last", async (): Promise<void> => {
  const manifest = 'Files of this chat:\n"/files/receipt.png" 70';
  const { items } = await buildChatCompletionInput(
    [],
    [{ type: "text", text: "What did I pay?" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    { manifest, viewParts: new Map() },
  );

  const clock = items.at(-1);
  const listing = items.at(-2);
  assert.ok(clock !== undefined && "content" in clock && typeof clock.content === "string");
  assert.match(clock.content, /^Current datetime/u);
  assert.ok(listing !== undefined && "content" in listing);
  assert.equal(listing.content, manifest);
  assert.equal("role" in listing ? listing.role : null, "system");
});

test("buildChatCompletionInput replays a stored view_file result as a native image part", async (): Promise<void> => {
  const imagePart = {
    type: "input_image",
    detail: "auto",
    image_url: "data:image/png;base64,iVBORw0KGgo",
  } as const;
  const viewedItem = buildChatFileViewReplayItem(
    "call-view-1",
    '"/files/receipt.png", image/png, 70 bytes. The image follows this line.',
    imagePart,
    {
      fileId: "file-1",
      path: "/files/receipt.png",
      sha256: "a".repeat(64),
      page: null,
    },
  );
  const localMessages: ReadonlyArray<ServerChatMessage> = [
    { role: "user", content: [{ type: "text", text: "Look at the receipt" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "It is 12 EUR" }],
      openaiItems: toPersistedOpenAIReplayItems([
        {
          type: "function_call",
          call_id: "call-view-1",
          name: "view_file",
          arguments: '{"path":"/files/receipt.png","page":null}',
        },
        viewedItem,
      ]),
    },
  ];

  const { items } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "And the total?" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
    { manifest: null, viewParts: new Map([["call-view-1", imagePart]]) },
  );

  const replayed = items.find((item) => item.type === "function_call_output");
  assert.ok(replayed !== undefined);
  const output = "output" in replayed ? replayed.output : null;
  assert.ok(Array.isArray(output));
  assert.deepEqual(output.at(-1), imagePart);
  // Stored as a reference, so the row the replay came from holds no bytes.
  assert.equal(
    JSON.stringify(localMessages[1]?.openaiItems).includes("base64"),
    false,
  );
});
