import assert from "node:assert/strict";
import test from "node:test";

import type { StoredMessage } from "@/lib/chatHistory";
import {
  buildChatTranscriptMarkdown,
  buildChatTranscriptSuggestedFileName,
  formatUtcTimestamp,
} from "./chatTranscriptMarkdown";

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

test("formatUtcTimestamp uses a simple UTC format", () => {
  assert.equal(formatUtcTimestamp(Date.UTC(2026, 2, 24, 15, 42, 11)), "2026-03-24 15:42:11");
});

test("buildChatTranscriptSuggestedFileName uses the UTC timestamp", () => {
  assert.equal(
    buildChatTranscriptSuggestedFileName(Date.UTC(2026, 2, 24, 15, 42, 11)),
    "ai-chat-2026-03-24_15-42-11.md",
  );
});

test("buildChatTranscriptMarkdown exports messages, tool sections, statuses, and UTC timestamps", () => {
  const messages: ReadonlyArray<StoredMessage> = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "text/csv", base64Data: "abc", fileName: "report.csv" },
        { type: "image", mediaType: "image/png", base64Data: "def" },
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

  const result = buildChatTranscriptMarkdown({
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
  assert.match(result.markdown, /### Attachments\n- report\.csv\n- \[image\]/);
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
