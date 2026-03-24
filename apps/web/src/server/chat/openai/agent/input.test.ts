import assert from "node:assert/strict";
import test from "node:test";

import * as XLSX from "xlsx";
import type { ChatMessage, ContentPart } from "@/server/chat/types";
import {
  buildInput,
  getAllUserFileAttachments,
  getCodeInterpreterAttachmentFileNames,
  getLatestUserFileAttachments,
} from "./input";

const createWorkbookBase64 = (): string => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name", "amount"],
      ["Taxi", 12],
      ["Lunch", 18],
    ]),
    "Expenses",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["currency", "balance"],
      ["EUR", 100],
    ]),
    "Balances",
  );
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
};

test("getLatestUserFileAttachments keeps original files even when text companions are injected", () => {
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

test("getAllUserFileAttachments returns unique files across user history", () => {
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

  assert.deepEqual(getAllUserFileAttachments(messages), [
    { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
    { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
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

  assert.deepEqual(getCodeInterpreterAttachmentFileNames(attachments), ["expenses.csv", "balances", "statement.pdf", "report.xlsx"]);
});

test("buildInput injects CSV and workbook attachments as raw text while keeping original files", () => {
  const workbookBase64 = createWorkbookBase64();
  const content: ReadonlyArray<ContentPart> = [
    { type: "text", text: "Latest" },
    { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
    { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: workbookBase64 },
    { type: "file", fileName: "statement.pdf", mediaType: "application/pdf", base64Data: "cGRm" },
  ];

  assert.deepEqual(buildInput(content), [{
    role: "user",
    type: "message",
    content: [
      { type: "input_text", text: "Latest" },
      { type: "input_text", text: "Attached CSV file: new.csv\n```csv\nnew\n```" },
      { type: "input_file", file: "data:text/csv;base64,bmV3", filename: "new.csv" },
      {
        type: "input_text",
        text: "Attached workbook: report.xlsx\nSheet: Expenses\n```csv\nname,amount\nTaxi,12\nLunch,18\n```\nSheet: Balances\n```csv\ncurrency,balance\nEUR,100\n```",
      },
      { type: "input_file", file: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${workbookBase64}`, filename: "report.xlsx" },
      { type: "input_file", file: "data:application/pdf;base64,cGRm", filename: "statement.pdf" },
    ],
  }]);
});
