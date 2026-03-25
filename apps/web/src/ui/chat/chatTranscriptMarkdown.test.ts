import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import type { StoredMessage } from "@/lib/chatHistory";
import {
  buildChatTranscriptMarkdown,
  buildChatTranscriptSuggestedFileName,
  formatUtcTimestamp,
} from "./chatTranscriptMarkdown";

const PDF_BASE64 = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KQlQKL0YxIDI0IFRmCjcyIDEwMCBUZAooSGVsbG8gUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9Sb290IDEgMCBSIC9TaXplIDYgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=";
const DOCX_BASE64 = "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";

const translations: Readonly<Record<string, string>> = {
  "chat.exportTitle": "AI Chat Export",
  "chat.exportTimestampsUtc": "All timestamps below are in UTC",
  "chat.exportedAt": "Exported at",
  "chat.exportSuggestedFilename": "Suggested filename",
  "chat.exportMessageHeading": "Message {{index}} - {{author}}",
  "chat.exportAuthorUser": "User",
  "chat.exportAuthorAssistant": "Assistant",
  "chat.exportTime": "Time",
  "chat.exportAttachments": "Attachments",
  "chat.exportRequest": "Request",
  "chat.exportResponse": "Response",
  "chat.exportStatus": "Status",
  "chat.exportError": "Error",
  "chat.exportActivity": "Activity",
  "chat.stopped": "Stopped",
  "chat.thinking": "Thinking",
  "chat.thinkingSummary": "Thinking summary",
  "chat.toolDbQuery": "Database query",
  "chat.toolCodeExec": "Code execution",
  "chat.toolCodeInterpreter": "Code interpreter",
  "chat.toolWebSearch": "Web search",
  "chat.toolStatusRunning": "Running",
  "chat.toolStatusInProgress": "In progress",
  "chat.toolStatusInterpreting": "Interpreting",
  "chat.toolStatusSearching": "Searching",
  "chat.toolStatusCompleted": "Completed",
  "chat.toolStatusFailed": "Failed",
  "chat.toolStatusIncomplete": "Incomplete",
};

const t = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string => {
  const template = translations[key];
  if (template === undefined) {
    throw new Error(`Missing translation for key=${key}`);
  }
  if (params === undefined) {
    return template;
  }

  let value = template;
  for (const [paramKey, paramValue] of Object.entries(params)) {
    value = value.replaceAll(`{{${paramKey}}}`, String(paramValue));
  }
  return value;
};

const assertSubstringsInOrder = (
  content: string,
  substrings: ReadonlyArray<string>,
): void => {
  let lastIndex = -1;

  for (const substring of substrings) {
    const nextIndex = content.indexOf(substring);
    assert.notEqual(nextIndex, -1, `Expected substring not found: ${substring}`);
    assert.ok(
      nextIndex > lastIndex,
      `Expected substring "${substring}" to appear after index ${String(lastIndex)}, got ${String(nextIndex)}`,
    );
    lastIndex = nextIndex;
  }
};

const encodeText = (
  value: string,
): string =>
  Buffer.from(value, "utf8").toString("base64");

const buildWorkbookBase64 = (): string => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name", "amount"],
      ["groceries", 42],
    ]),
    "Budget",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["currency", "rate"],
      ["EUR", 1],
    ]),
    "Rates",
  );
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
};

test("formatUtcTimestamp uses a simple UTC format", () => {
  assert.equal(formatUtcTimestamp(Date.UTC(2026, 2, 24, 15, 42, 11)), "2026-03-24 15:42:11");
});

test("buildChatTranscriptSuggestedFileName uses the UTC timestamp", () => {
  assert.equal(
    buildChatTranscriptSuggestedFileName(Date.UTC(2026, 2, 24, 15, 42, 11)),
    "ai-chat-2026-03-24_15-42-11.md",
  );
});

test("buildChatTranscriptMarkdown exports inline attachment bodies and UTC timestamps", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "text/csv", base64Data: encodeText("date,amount\n2026-03-24,10"), fileName: "report.csv" },
        { type: "image", mediaType: "image/png", base64Data: "AQID" },
        { type: "text", text: "Please analyze this import." },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 40, 0),
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning_summary",
          summary: "Checked the file layout before answering.",
          streamPosition: {
            itemId: "reasoning-1",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 1,
          },
        },
        {
          type: "tool_call",
          id: "tool-1",
          name: "query_database",
          status: "completed",
          providerStatus: "completed",
          input: "{\"sql\":\"SELECT 1\"}",
          output: "{\"rows\":[{\"value\":1}],\"meta\":{\"full\":true}}",
          streamPosition: {
            itemId: "tool-1-item",
            outputIndex: 1,
            contentIndex: null,
            sequenceNumber: 2,
          },
        },
        {
          type: "tool_call",
          id: "tool-2",
          name: "web_search",
          status: "started",
          providerStatus: "in_progress",
          input: "{\"query\":\"btc price\"}",
          output: "{\"partial\":true}",
          streamPosition: {
            itemId: "tool-2-item",
            outputIndex: 2,
            contentIndex: null,
            sequenceNumber: 3,
          },
        },
        { type: "text", text: "I found the matching records." },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 41, 3),
      isError: false,
      isStopped: true,
    },
    {
      role: "assistant",
      content: [],
      timestamp: Date.UTC(2026, 2, 24, 15, 41, 30),
      isError: true,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "running",
    exportedAt: Date.UTC(2026, 2, 24, 15, 42, 11),
    t,
  });

  assert.match(result.markdown, /^# AI Chat Export/m);
  assert.equal(result.markdown.match(/All timestamps below are in UTC/g)?.length, 1);
  assert.match(result.markdown, /Exported at: 2026-03-24 15:42:11/);
  assert.match(result.markdown, /Suggested filename: ai-chat-2026-03-24_15-42-11.md/);
  assert.match(result.markdown, /## Message 1 - User/);
  assert.match(result.markdown, /Time: 2026-03-24 15:40:00/);
  assert.match(result.markdown, /#### report\.csv \(text\/csv\)/);
  assert.match(result.markdown, /```csv\ndate,amount\n2026-03-24,10\n```/);
  assert.match(result.markdown, /#### \[image\] \(image\/png\)\n\[binary-data\]/);
  assert.match(result.markdown, /Please analyze this import\./);
  assert.match(result.markdown, /## Message 2 - Assistant/);
  assert.match(result.markdown, /Status: Stopped/);
  assert.match(result.markdown, /### Thinking summary\n```text\nChecked the file layout before answering\.\n```/);
  assert.match(result.markdown, /### Database query \(Completed\)/);
  assert.match(result.markdown, /#### Request\n```text\nSELECT 1\n```/);
  assert.match(result.markdown, /#### Response\n```text\n\{\n  "rows": \[/);
  assert.match(result.markdown, /"full": true/);
  assert.match(result.markdown, /### Web search \(In progress\)/);
  assert.match(result.markdown, /#### Response\n```text\nIn progress\n```/);
  assert.match(result.markdown, /I found the matching records\./);
  assert.match(result.markdown, /## Message 3 - Assistant/);
  assert.match(result.markdown, /Status: Error/);
  assert.match(result.markdown, /Activity: Thinking/);
  assert.doesNotMatch(result.markdown, /Time: .*UTC/);
});

test("buildChatTranscriptMarkdown preserves top-level message order exactly as provided", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [{ type: "text", text: "first user message" }],
      timestamp: Date.UTC(2026, 2, 24, 15, 40, 0),
      isError: false,
      isStopped: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "second assistant message" }],
      timestamp: Date.UTC(2026, 2, 24, 15, 41, 0),
      isError: false,
      isStopped: false,
    },
    {
      role: "user",
      content: [{ type: "text", text: "third user message" }],
      timestamp: Date.UTC(2026, 2, 24, 15, 42, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 43, 0),
    t,
  });

  assertSubstringsInOrder(result.markdown, [
    "## Message 1 - User",
    "first user message",
    "## Message 2 - Assistant",
    "second assistant message",
    "## Message 3 - User",
    "third user message",
  ]);
});

test("buildChatTranscriptMarkdown preserves visible block order inside an assistant message", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "tool-1",
          name: "query_database",
          status: "completed",
          providerStatus: "completed",
          input: "{\"sql\":\"SELECT 1\"}",
          output: "{\"rows\":[{\"value\":1}]}",
          streamPosition: {
            itemId: "tool-1",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 1,
          },
        },
        { type: "file", mediaType: "text/csv", base64Data: encodeText("a,b\n1,2"), fileName: "report.csv" },
        { type: "text", text: "Answer after attachment list." },
        {
          type: "reasoning_summary",
          summary: "Looked at the imported rows.",
          streamPosition: {
            itemId: "reasoning-1",
            outputIndex: 1,
            contentIndex: null,
            sequenceNumber: 2,
          },
        },
        { type: "text", text: "Final sentence." },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 44, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 45, 0),
    t,
  });

  assertSubstringsInOrder(result.markdown, [
    "### Database query (Completed)",
    "#### report.csv (text/csv)",
    "Answer after attachment list.",
    "### Thinking summary\n```text\nLooked at the imported rows.\n```",
    "Final sentence.",
  ]);
});

test("buildChatTranscriptMarkdown keeps user attachments immediately before the first text block", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "text/csv", base64Data: encodeText("name,amount\nfood,12"), fileName: "budget.csv" },
        { type: "image", mediaType: "image/png", base64Data: "AQID" },
        { type: "text", text: "Please compare these imports." },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 46, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 47, 0),
    t,
  });

  assertSubstringsInOrder(result.markdown, [
    "## Message 1 - User",
    "#### budget.csv (text/csv)",
    "#### [image] (image/png)",
    "Please compare these imports.",
  ]);
});

test("buildChatTranscriptMarkdown uses the same chronology-normalized assistant block order as the chat UI", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "code-1",
          name: "code_interpreter_call",
          status: "completed",
          providerStatus: "completed",
          input: "print('done')",
          output: "done",
          streamPosition: {
            itemId: "code-1-item",
            outputIndex: 3,
            contentIndex: null,
            sequenceNumber: 40,
          },
        },
        {
          type: "reasoning_summary",
          summary: "First thinking summary.",
          streamPosition: {
            itemId: "reasoning-1",
            outputIndex: 0,
            contentIndex: null,
            sequenceNumber: 10,
          },
        },
        {
          type: "tool_call",
          id: "db-2",
          name: "query_database",
          status: "completed",
          providerStatus: "completed",
          input: "{\"sql\":\"SELECT 2\"}",
          output: "{\"rows\":[2]}",
          streamPosition: {
            itemId: "db-2-item",
            outputIndex: 2,
            contentIndex: null,
            sequenceNumber: 30,
          },
        },
        {
          type: "tool_call",
          id: "db-1",
          name: "query_database",
          status: "completed",
          providerStatus: "completed",
          input: "{\"sql\":\"SELECT 1\"}",
          output: "{\"rows\":[1]}",
          streamPosition: {
            itemId: "db-1-item",
            outputIndex: 1,
            contentIndex: null,
            sequenceNumber: 20,
          },
        },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 48, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 49, 0),
    t,
  });

  assertSubstringsInOrder(result.markdown, [
    "### Thinking summary\n```text\nFirst thinking summary.\n```",
    "### Database query (Completed)",
    "SELECT 1",
    "SELECT 2",
    "### Code interpreter (Completed)",
  ]);
});

test("buildChatTranscriptMarkdown keeps workbook text, marks PDF as native, and extracts DOCX text", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64Data: buildWorkbookBase64(),
          fileName: "report.xlsx",
        },
        {
          type: "file",
          mediaType: "application/pdf",
          base64Data: PDF_BASE64,
          fileName: "statement.pdf",
        },
        {
          type: "file",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          base64Data: DOCX_BASE64,
          fileName: "notes.docx",
        },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 50, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 51, 0),
    t,
  });

  assert.match(result.markdown, /#### report\.xlsx \(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\)/);
  assert.match(result.markdown, /Sheet: Budget\n```csv\nname,amount\ngroceries,42\n```/);
  assert.match(result.markdown, /Sheet: Rates\n```csv\ncurrency,rate\nEUR,1\n```/);
  assert.match(result.markdown, /#### statement\.pdf \(application\/pdf\)\n\[pdf-openai-native-attached\]/);
  assert.match(result.markdown, /#### notes\.docx \(application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\)/);
  assert.match(result.markdown, /```text\nHello DOCX\n```/);
});

test("buildChatTranscriptMarkdown keeps opaque binary files as placeholders", async () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "application/octet-stream", base64Data: "AAEC", fileName: "blob.bin" },
      ],
      timestamp: Date.UTC(2026, 2, 24, 15, 52, 0),
      isError: false,
      isStopped: false,
    },
  ];

  const result = await buildChatTranscriptMarkdown({
    messages,
    runState: "idle",
    exportedAt: Date.UTC(2026, 2, 24, 15, 53, 0),
    t,
  });

  assert.match(result.markdown, /#### blob\.bin \(application\/octet-stream\)\n\[binary-data\]/);
});
