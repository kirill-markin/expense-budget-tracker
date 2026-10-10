import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { CHAT_SENT_INPUT_BUDGET_TOKENS } from "@/lib/chatModels";
import {
  LegacyPdfFileAttachmentError,
  UnsupportedImageMediaTypeError,
} from "@/server/chat/attachments/validation";
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

const HEIC_BASE64_PREFIX = "AAAAGGZ0eXBoZWljAAAAAA==";
const JPEG_BASE64_PREFIX = "/9j/4AAQSkZJRg==";
const CSV_BASE64 = Buffer.from(
  "date,amount\n2026-08-16,-844.82",
  "utf8",
).toString("base64");

test("buildChatCompletionInput rejects a legacy HEIC attachment without mutating history", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "file",
      fileName: "IMG_7071.HEIC",
      mediaType: "image/heic",
      base64Data: HEIC_BASE64_PREFIX,
    }],
  }];
  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue" }];
  const originalMessages = structuredClone(localMessages);
  const originalTurnInput = structuredClone(turnInput);

  await assert.rejects(
    buildChatCompletionInput(localMessages, turnInput, "Europe/Madrid", "session-1", "req-1"),
    (error: unknown): boolean => {
      assert.ok(error instanceof UnsupportedStoredChatAttachmentError);
      assert.equal(error.fileName, "IMG_7071.HEIC");
      assert.equal(error.mediaType, "image/heic");
      assert.match(error.message, /filename "IMG_7071\.HEIC"/);
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

test("buildChatCompletionInput replays CSV content identified by MIME without a native input file", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "file",
      fileName: "statement.data",
      mediaType: "text/csv",
      base64Data: CSV_BASE64,
    }],
  }];

  const { items: input } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
  );

  assert.deepEqual(input[1], {
    role: "user",
    type: "message",
    content: [{
      type: "input_text",
      text: "Attached file: statement.data\n```text\ndate,amount\n2026-08-16,-844.82\n```",
    }],
  });
});

test("buildChatCompletionInput sends current CSV content identified by uppercase extension without a native input file", async (): Promise<void> => {
  const { items: input } = await buildChatCompletionInput(
    [],
    [{
      type: "file",
      fileName: "statement.CSV",
      mediaType: "application/octet-stream",
      base64Data: CSV_BASE64,
    }],
    "Europe/Madrid",
    "session-1",
    "req-1",
  );

  assert.deepEqual(input[1], {
    role: "user",
    type: "message",
    content: [{
      type: "input_text",
      text: "Attached file: statement.CSV\n```csv\ndate,amount\n2026-08-16,-844.82\n```",
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

test("buildChatCompletionInput rejects a stored legacy PDF before OpenAI mapping", async (): Promise<void> => {
  const legacyPdfs: ReadonlyArray<Extract<ContentPart, { type: "file" }>> = [
    {
      type: "file",
      fileName: "legacy.bin",
      mediaType: "application/pdf",
      base64Data: Buffer.from("opaque").toString("base64"),
    },
    {
      type: "file",
      fileName: "legacy.pdf",
      mediaType: "application/octet-stream",
      base64Data: Buffer.from("opaque").toString("base64"),
    },
    {
      type: "file",
      fileName: "legacy.bin",
      mediaType: "application/octet-stream",
      base64Data: Buffer.from("%PDF-1.7 private").toString("base64"),
    },
  ];

  for (const legacyPdf of legacyPdfs) {
    const localMessages: ReadonlyArray<ServerChatMessage> = [{
      role: "user",
      content: [legacyPdf],
    }];
    await assert.rejects(
      buildChatCompletionInput(
        localMessages,
        [{ type: "text", text: "Continue" }],
        "Europe/Madrid",
        "session-1",
        "req-1",
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof UnsupportedStoredChatAttachmentError);
        assert.equal(error.fileName, legacyPdf.fileName);
        assert.ok(error.cause instanceof LegacyPdfFileAttachmentError);
        return true;
      },
    );
  }
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

test("buildChatCompletionInput keeps replaying history when a small workbook is attached", async (): Promise<void> => {
  // A container attachment cannot be sized from its own bytes, and the cap that
  // bounds its extracted text is 200k tokens - more than the whole budget. Sized
  // that way, a tiny spreadsheet made no cut fit, collapsed the replay to the
  // newest pair, and the monotone boundary then held it there for the rest of
  // the session. This workbook extracts to a few hundred characters and must be
  // charged that.
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["date", "amount"], ["2026-08-16", -844.82]]),
    "Ledger",
  );
  const localMessages = createLongStoredSession(20, null);
  const turnInput: ReadonlyArray<ContentPart> = [
    { type: "text", text: "What does this sheet say?" },
    {
      type: "file",
      fileName: "ledger.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64Data: XLSX.write(workbook, { type: "base64", bookType: "xlsx" }),
    },
  ];

  const { items: input, replayedMessages } = await buildChatCompletionInput(
    localMessages,
    turnInput,
    "Europe/Madrid",
    "session-1",
    "req-1",
  );

  // The session is still replayed around the attachment rather than erased, and
  // the workbook is sent once, as extracted CSV.
  assert.ok(
    replayedMessages > 2,
    `Only ${String(replayedMessages)} messages survived a ${String(localMessages.length)} `
    + "message session with one small workbook attached",
  );
  const serializedInput = JSON.stringify(input);
  assert.ok(serializedInput.includes("Sheet: Ledger"));
  assert.ok(serializedInput.includes("2026-08-16"));
  assert.equal(serializedInput.includes("truncated: extracted text"), false);
});

test("buildChatCompletionInput keeps replaying history around a small stored workbook", async (): Promise<void> => {
  // The stored-attachment half of the same defect. One small spreadsheet sitting
  // in the history used to be charged the extracted-text cap - more than the
  // whole budget for a single content part - so every cut was unfit and the
  // monotone boundary pinned the session at its newest pair for good.
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["date", "amount"], ["2026-08-16", -844.82]]),
    "Ledger",
  );
  const storedWorkbookTurn: ReadonlyArray<ServerChatMessage> = [
    {
      role: "user",
      content: [{
        type: "file",
        fileName: "ledger.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        base64Data: XLSX.write(workbook, { type: "base64", bookType: "xlsx" }),
      }],
    },
    ...createLongStoredTurn(99, []).slice(1),
  ];
  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue" }];

  const withoutWorkbook = await buildChatCompletionInput(
    createLongStoredSession(20, null),
    turnInput,
    "Europe/Madrid",
    "session-1",
    "req-1",
  );
  const withWorkbook = await buildChatCompletionInput(
    [...createLongStoredSession(19, null), ...storedWorkbookTurn],
    turnInput,
    "Europe/Madrid",
    "session-1",
    "req-1",
  );

  // One stored spreadsheet must not cost the session its history.
  assert.ok(
    withWorkbook.replayedMessages >= withoutWorkbook.replayedMessages - 2,
    `A stored workbook cut the replay from ${String(withoutWorkbook.replayedMessages)} `
    + `messages to ${String(withWorkbook.replayedMessages)}`,
  );
  // And it is replayed as its extracted CSV, once.
  assert.ok(JSON.stringify(withWorkbook.items).includes("Sheet: Ledger"));
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
