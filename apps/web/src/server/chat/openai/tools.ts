import { tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export type AgentContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

const createToolSuccessResult = (
  toolName: string,
  payload: Readonly<Record<string, unknown>>,
): string =>
  JSON.stringify({
    ok: true,
    tool: toolName,
    ...payload,
  });

const createToolErrorResult = (
  toolName: string,
  payload: Readonly<Record<string, unknown>>,
): string =>
  JSON.stringify({
    ok: false,
    tool: toolName,
    ...payload,
  });

const serializeToolError = (
  error: unknown,
): Readonly<{
  name: string;
  message: string;
}> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
};

export const pgQueryTool = tool({
  name: "query_database",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    sql: z.unknown().describe("SQL script to execute. One or more SELECT, WITH, INSERT, UPDATE, or DELETE statements separated by semicolons."),
  }),
  execute: async (
    input: { sql: unknown },
    runContext?: RunContext<AgentContext>,
  ): Promise<string> => {
    if (runContext === undefined) {
      throw new Error("pgQueryTool: missing run context");
    }

    if (typeof input.sql !== "string") {
      return createToolErrorResult("query_database", {
        sql: null,
        error: {
          name: "InvalidToolInput",
          message: "query_database requires a string sql field",
        },
      });
    }

    try {
      const { userId, workspaceId } = runContext.context;
      const result = await execQuery(input.sql, userId, workspaceId);
      return createToolSuccessResult("query_database", {
        sql: input.sql,
        ...JSON.parse(result.json) as Readonly<Record<string, unknown>>,
      });
    } catch (error) {
      return createToolErrorResult("query_database", {
        sql: input.sql,
        error: serializeToolError(error),
      });
    }
  },
});

export const captureExtractedFileDataTool = tool({
  name: "capture_extracted_file_data",
  description: "Store raw extracted file data as a durable function_call_output item visible to both the model and the user interface.",
  parameters: z.object({
    sourceFileName: z.unknown().describe("Original attached filename."),
    sourceMediaType: z.unknown().describe("Original attached media type."),
    extractionFormat: z.unknown().describe("Raw extracted format: text, json, or csv."),
    rawData: z.unknown().describe("The complete raw extracted content."),
    extractionNotes: z.unknown().nullable().describe("Optional extraction notes or parser observations."),
  }),
  execute: async (
    input: Readonly<{
      sourceFileName: unknown;
      sourceMediaType: unknown;
      extractionFormat: unknown;
      rawData: unknown;
      extractionNotes: unknown;
    }>,
  ): Promise<string> => {
    if (typeof input.sourceFileName !== "string" || input.sourceFileName.length === 0) {
      return createToolErrorResult("capture_extracted_file_data", {
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires a non-empty string sourceFileName",
        },
      });
    }

    if (typeof input.sourceMediaType !== "string" || input.sourceMediaType.length === 0) {
      return createToolErrorResult("capture_extracted_file_data", {
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires a non-empty string sourceMediaType",
        },
      });
    }

    if (input.extractionFormat !== "text" && input.extractionFormat !== "json" && input.extractionFormat !== "csv") {
      return createToolErrorResult("capture_extracted_file_data", {
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires extractionFormat to be one of: text, json, csv",
        },
      });
    }

    if (typeof input.rawData !== "string" || input.rawData.length === 0) {
      return createToolErrorResult("capture_extracted_file_data", {
        sourceFileName: input.sourceFileName,
        sourceMediaType: input.sourceMediaType,
        extractionFormat: input.extractionFormat,
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires a non-empty string rawData payload",
        },
      });
    }

    if (input.extractionNotes !== undefined && input.extractionNotes !== null && typeof input.extractionNotes !== "string") {
      return createToolErrorResult("capture_extracted_file_data", {
        sourceFileName: input.sourceFileName,
        sourceMediaType: input.sourceMediaType,
        extractionFormat: input.extractionFormat,
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data accepts extractionNotes only as a string when provided",
        },
      });
    }

    return createToolSuccessResult("capture_extracted_file_data", {
      sourceFileName: input.sourceFileName,
      sourceMediaType: input.sourceMediaType,
      extractionFormat: input.extractionFormat,
      rawData: input.rawData,
      extractionNotes: input.extractionNotes ?? null,
    });
  },
});
