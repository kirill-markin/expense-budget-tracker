import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_ATTACHMENT_MAXIMUM_BYTES } from "@/server/chat/attachments/validation";
import type { ChatFile } from "@/server/chatFiles/store";
import {
  viewChatFileWithDependencies,
  type ChatFileViewContext,
  type ChatFileViewDependencies,
} from "@/server/chatFiles/viewFile";

const CONTEXT: ChatFileViewContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  isDemoMode: false,
};

/** A real 1x1 PNG, so the reused image checks see a genuine signature. */
const PNG_BYTES = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
));

const JPEG_BYTES = Uint8Array.from(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));

const createChatFile = (
  overrides: Partial<ChatFile>,
): ChatFile => ({
  fileId: "22222222-2222-4222-8222-222222222222",
  sessionId: CONTEXT.sessionId,
  origin: "attachment",
  sourceFileId: null,
  path: "/files/receipt.png",
  objectKey: `sessions/${CONTEXT.sessionId}/22222222-2222-4222-8222-222222222222`,
  mediaType: "image/png",
  sizeBytes: PNG_BYTES.byteLength,
  sha256: "a".repeat(64),
  isConfirmed: true,
  derivativesPreparedAt: null,
  derivativesError: null,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const createDependencies = (
  overrides: Partial<ChatFileViewDependencies>,
): ChatFileViewDependencies => ({
  getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({}),
  readObjectBytes: async (): Promise<Uint8Array | null> => PNG_BYTES,
  presignReadUrl: async (): Promise<string> => "https://bucket.example/object?signature",
  invokeSandbox: async (): Promise<never> => {
    throw new Error("the sandbox must not be invoked for this view");
  },
  readFunctionName: (): string | null => "chat-sandbox",
  log: (): void => {},
  ...overrides,
});

test("an image is read, checked, and returned as a native image part with a reference", async (): Promise<void> => {
  const result = await viewChatFileWithDependencies(
    "/files/receipt.png",
    null,
    CONTEXT,
    createDependencies({}),
  );

  assert.equal(result.kind, "viewed");
  if (result.kind !== "viewed") {
    return;
  }
  // A native part and not stringified base64: the same image inside the text of
  // a tool result costs 10 to 20 times what this costs.
  assert.equal(result.view.part.type, "input_image");
  assert.equal(
    result.view.part.type === "input_image" ? result.view.part.image_url : "",
    `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
  );
  assert.equal(result.view.text.includes("base64"), false);
  assert.match(result.view.text, /^"\/files\/receipt\.png", image\/png, 70 bytes\./u);
  assert.deepEqual(result.view.reference, {
    fileId: "22222222-2222-4222-8222-222222222222",
    path: "/files/receipt.png",
    sha256: "a".repeat(64),
    page: null,
  });
});

test("a file whose bytes are not the image its name claims is refused, not sent", async (): Promise<void> => {
  const result = await viewChatFileWithDependencies(
    "/files/receipt.png",
    null,
    CONTEXT,
    createDependencies({
      readObjectBytes: async (): Promise<Uint8Array | null> => JPEG_BYTES,
    }),
  );

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") {
    return;
  }
  assert.equal(result.refusal.code, "chat_file_not_viewable");
  assert.match(result.refusal.message, /signature that does not match/u);
});

test("a PDF page is copied out by the sandbox and returned as a native file part", async (): Promise<void> => {
  const requests: Array<string> = [];
  const result = await viewChatFileWithDependencies(
    "/files/statement.pdf",
    3,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({
        path: "/files/statement.pdf",
        mediaType: "application/pdf",
        sizeBytes: 182_304,
      }),
      readObjectBytes: async (): Promise<never> => {
        throw new Error("a PDF page is read by the sandbox, never by the web task");
      },
      invokeSandbox: async (_functionName: string, payload: string): Promise<string> => {
        requests.push(payload);
        return JSON.stringify({
          status: "rendered",
          page: 3,
          pageCount: 12,
          pdfBase64: "JVBERi0=",
          sizeBytes: 2_233,
          durationMs: 97,
        });
      },
    }),
  );

  const request = JSON.parse(requests[0] ?? "{}") as Readonly<{
    operation?: string;
    page?: number;
  }>;
  assert.equal(request.operation, "pdf_page");
  assert.equal(request.page, 3);
  assert.equal(result.kind, "viewed");
  if (result.kind !== "viewed") {
    return;
  }
  assert.deepEqual(result.view.part, {
    type: "input_file",
    filename: "page-3-of-statement.pdf",
    file_data: "data:application/pdf;base64,JVBERi0=",
  });
  assert.match(result.view.text, /page 3 of 12/u);
  assert.equal(result.view.reference.page, 3);
});

test("the sandbox's own verdict on a page is what the model is told", async (): Promise<void> => {
  const result = await viewChatFileWithDependencies(
    "/files/statement.pdf",
    40,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({
        path: "/files/statement.pdf",
        mediaType: "application/pdf",
      }),
      invokeSandbox: async (): Promise<string> => JSON.stringify({
        status: "failed",
        error: '"/files/statement.pdf" has 12 pages, so page 40 is not one of them',
        durationMs: 42,
      }),
    }),
  );

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") {
    return;
  }
  // The page count is the only way the model learns which page to ask for.
  assert.match(result.refusal.message, /has 12 pages/u);
});

test("anything that is not an image or a PDF page is sent to bash instead", async (): Promise<void> => {
  const spreadsheet = await viewChatFileWithDependencies(
    "/files/budget.xlsx",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({
        path: "/files/budget.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    }),
  );
  assert.equal(spreadsheet.kind, "refused");
  assert.match(
    spreadsheet.kind === "refused" ? spreadsheet.refusal.message : "",
    /which view_file does not show/u,
  );
  assert.match(
    spreadsheet.kind === "refused" ? spreadsheet.refusal.instructions : "",
    /bash/u,
  );

  const pdfWithNoPage = await viewChatFileWithDependencies(
    "/files/statement.pdf",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({
        path: "/files/statement.pdf",
        mediaType: "application/pdf",
      }),
    }),
  );
  assert.equal(pdfWithNoPage.kind, "refused");
  assert.match(
    pdfWithNoPage.kind === "refused" ? pdfWithNoPage.refusal.message : "",
    /one page of a PDF at a time/u,
  );

  const missing = await viewChatFileWithDependencies(
    "/files/nothing.png",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => null,
    }),
  );
  assert.equal(missing.kind, "refused");
  assert.equal(missing.kind === "refused" ? missing.refusal.code : "", "chat_file_not_found");
});

test("a /work file is viewable under the name the model gave it", async (): Promise<void> => {
  // Every /work object is signed with the opaque media type, so the extension
  // is the only thing that can classify a chart a command just wrote.
  const result = await viewChatFileWithDependencies(
    "/work/chart.png",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile | null> => createChatFile({
        origin: "work",
        path: "/work/chart.png",
        mediaType: "application/octet-stream",
      }),
    }),
  );

  assert.equal(result.kind, "viewed");
  assert.equal(
    result.kind === "viewed" ? result.view.part.type : "",
    "input_image",
  );
});

test("a file the bucket no longer holds is reported, not thrown", async (): Promise<void> => {
  const result = await viewChatFileWithDependencies(
    "/files/receipt.png",
    null,
    CONTEXT,
    createDependencies({
      readObjectBytes: async (): Promise<Uint8Array | null> => null,
    }),
  );

  assert.equal(result.kind, "refused");
  assert.equal(
    result.kind === "refused" ? result.refusal.code : "",
    "chat_file_unavailable",
  );
});

test("an upload still in flight is told to wait, not to attach the file again", async (): Promise<void> => {
  // Without this refusal the read below answers "its stored copy is gone",
  // whose remedy is the wrong one: the upload is running and will finish, so
  // the user is told to wait rather than to attach the file a second time.
  const result = await viewChatFileWithDependencies(
    "/files/receipt.png",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile> => createChatFile({ isConfirmed: false }),
      readObjectBytes: async (): Promise<never> => {
        throw new Error("an unconfirmed row has no object to read");
      },
    }),
  );

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") {
    return;
  }
  assert.equal(result.refusal.code, "chat_file_not_ready");
  assert.match(result.refusal.message, /still being uploaded/u);
  assert.match(result.refusal.instructions, /upload has not finished/u);
  assert.doesNotMatch(result.refusal.instructions, /attached again/u);
});

test("an image past the attachment byte ceiling is refused before it is read", async (): Promise<void> => {
  // The ceiling is on the row rather than on the bytes, so the object is never
  // fetched: a 40 MB image would otherwise be read, base64'd and only then
  // rejected by the shared attachment checks.
  const result = await viewChatFileWithDependencies(
    "/files/receipt.png",
    null,
    CONTEXT,
    createDependencies({
      getChatFileByPath: async (): Promise<ChatFile> => createChatFile({
        sizeBytes: CHAT_ATTACHMENT_MAXIMUM_BYTES + 1,
      }),
      readObjectBytes: async (): Promise<never> => {
        throw new Error("an image past the ceiling must not be read at all");
      },
    }),
  );

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") {
    return;
  }
  assert.equal(result.refusal.code, "chat_file_not_viewable");
  assert.match(
    result.refusal.message,
    new RegExp(`past the ${String(CHAT_ATTACHMENT_MAXIMUM_BYTES)} bytes one image may be shown as`, "u"),
  );
});
