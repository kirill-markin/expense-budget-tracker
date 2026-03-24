import assert from "node:assert/strict";
import test from "node:test";

import type { RunContext } from "@openai/agents";
import { captureExtractedFileDataTool, pgQueryTool } from "./tools";

const createRunContext = (): RunContext<{
  userId: string;
  workspaceId: string;
}> => ({
  context: {
    userId: "user-1",
    workspaceId: "workspace-1",
  },
}) as RunContext<{
  userId: string;
  workspaceId: string;
}>;

test("query_database returns a structured invalid-input error without throwing", async () => {
  const result = await pgQueryTool.invoke(
    createRunContext(),
    JSON.stringify({ sql: null }),
  );

  assert.deepEqual(JSON.parse(result), {
    ok: false,
    tool: "query_database",
    sql: null,
    error: {
      name: "InvalidToolInput",
      message: "query_database requires a string sql field",
    },
  });
});

test("capture_extracted_file_data echoes valid extracted data", async () => {
  const result = await captureExtractedFileDataTool.invoke(
    createRunContext(),
    JSON.stringify({
      sourceFileName: "statement.pdf",
      sourceMediaType: "application/pdf",
      extractionFormat: "json",
      rawData: "[{\"amount\":10}]",
      extractionNotes: "parsed with code interpreter",
    }),
  );

  assert.deepEqual(JSON.parse(result), {
    ok: true,
    tool: "capture_extracted_file_data",
    sourceFileName: "statement.pdf",
    sourceMediaType: "application/pdf",
    extractionFormat: "json",
    rawData: "[{\"amount\":10}]",
    extractionNotes: "parsed with code interpreter",
  });
});

test("capture_extracted_file_data returns a structured error for missing raw data", async () => {
  const result = await captureExtractedFileDataTool.invoke(
    createRunContext(),
    JSON.stringify({
      sourceFileName: "statement.pdf",
      sourceMediaType: "application/pdf",
      extractionFormat: "json",
      rawData: "",
      extractionNotes: null,
    }),
  );

  assert.deepEqual(JSON.parse(result), {
    ok: false,
    tool: "capture_extracted_file_data",
    sourceFileName: "statement.pdf",
    sourceMediaType: "application/pdf",
    extractionFormat: "json",
    error: {
      name: "InvalidToolInput",
      message: "capture_extracted_file_data requires a non-empty string rawData payload",
    },
  });
});
