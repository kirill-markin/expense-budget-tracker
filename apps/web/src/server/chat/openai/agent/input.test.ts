import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, ContentPart } from "@/server/chat/types";
import {
  buildInput,
  getAllUserFileAttachments,
  getCodeInterpreterAttachmentFileNames,
  getLatestUserFileAttachments,
} from "./input";

test("getLatestUserFileAttachments excludes CSV files that are injected as raw text", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Please inspect this" },
        { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
        { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
      ],
    },
  ];

  assert.deepEqual(getLatestUserFileAttachments(messages), [
    { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
  ]);
});

test("getAllUserFileAttachments returns unique non-CSV files across user history", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
        { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
      ],
    },
  ];

  assert.deepEqual(getAllUserFileAttachments(messages), []);
});

test("getAllUserFileAttachments drops raw-text CSV files entirely", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
        { type: "file", fileName: "statement.pdf", mediaType: "application/pdf", base64Data: "cGRm" },
      ],
    },
  ];

  assert.deepEqual(getAllUserFileAttachments(messages), [
    { type: "file", fileName: "statement.pdf", mediaType: "application/pdf", base64Data: "cGRm" },
  ]);
});

test("getCodeInterpreterAttachmentFileNames recognizes spreadsheet and PDF attachments", () => {
  const attachments = [
    { type: "file", fileName: "expenses.csv", mediaType: "application/octet-stream", base64Data: "MQ==" },
    { type: "file", fileName: "notes.txt", mediaType: "text/plain", base64Data: "Mg==" },
    { type: "file", fileName: "balances", mediaType: "text/csv", base64Data: "Mw==" },
    { type: "file", fileName: "statement.pdf", mediaType: "application/pdf", base64Data: "NA==" },
    { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "NQ==" },
  ] as const;

  assert.deepEqual(getCodeInterpreterAttachmentFileNames(attachments), ["statement.pdf", "report.xlsx"]);
});

test("buildInput injects CSV attachments as raw text and keeps PDFs as files", () => {
  const content: ReadonlyArray<ContentPart> = [
    { type: "text", text: "Latest" },
    { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
    { type: "file", fileName: "statement.pdf", mediaType: "application/pdf", base64Data: "cGRm" },
  ];

  assert.deepEqual(buildInput(content), [{
    role: "user",
    type: "message",
    content: [
      { type: "input_text", text: "Latest" },
      { type: "input_text", text: "Attached CSV file: new.csv\n```csv\nnew\n```" },
      { type: "input_file", file: "data:application/pdf;base64,cGRm", filename: "statement.pdf" },
    ],
  }]);
});
