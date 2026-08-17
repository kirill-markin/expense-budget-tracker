import assert from "node:assert/strict";
import test from "node:test";
import {
  LegacyPdfFileAttachmentError,
  UnsupportedImageMediaTypeError,
} from "@/server/chat/attachments/validation";
import {
  buildChatCompletionInput,
  sanitizeContentPartsForTelemetry,
  UnsupportedStoredChatAttachmentError,
} from "@/server/chat/openai/responses/input";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
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
    buildChatCompletionInput(localMessages, turnInput, "Europe/Madrid"),
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

  const input = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "What is in the image?" }],
    "Europe/Madrid",
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

  const input = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
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
  const input = await buildChatCompletionInput(
    [],
    [{
      type: "file",
      fileName: "statement.CSV",
      mediaType: "application/octet-stream",
      base64Data: CSV_BASE64,
    }],
    "Europe/Madrid",
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
  const input = await buildChatCompletionInput(
    [{ role: "user", content: [pdfPart] }],
    [{ type: "text", text: "Continue with this statement" }],
    "Europe/Madrid",
  );

  assert.equal(input.length, 3);
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

  const input = await buildChatCompletionInput(
    [{ role: "user", content: [persistedPdf] }],
    currentTurn,
    "Europe/Madrid",
  );

  assert.equal(input.length, 2);
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
