import { tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export type AgentContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

type CaptureExtractionFormat = "text" | "json" | "csv";

type CaptureExtractedFileDataInput = Readonly<{
  sourceFileName: string;
  sourceMediaType: string;
  extractionFormat: CaptureExtractionFormat;
  rawData: string;
  extractionNotes: string | null;
}>;

type ToolInputObject = Readonly<Record<string, unknown>>;

type ToolInvocationError = Readonly<{
  name?: unknown;
  message?: unknown;
  toolInvocation?: Readonly<{
    input?: unknown;
  }>;
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

const isInvalidToolInputError = (
  error: unknown,
): error is ToolInvocationError =>
  typeof error === "object"
  && error !== null
  && "name" in error
  && error.name === "InvalidToolInputError";

const tryParseToolInputObject = (
  error: ToolInvocationError,
): ToolInputObject | null => {
  const rawInput = error.toolInvocation?.input;
  if (typeof rawInput !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(rawInput) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as ToolInputObject;
  } catch {
    return null;
  }
};

const readStringField = (
  input: ToolInputObject | null,
  fieldName: string,
): string | null => {
  if (input === null) {
    return null;
  }

  const value = input[fieldName];
  return typeof value === "string" ? value : null;
};

const isCaptureExtractionFormat = (
  value: unknown,
): value is CaptureExtractionFormat =>
  value === "text" || value === "json" || value === "csv";

const createInvalidToolInputErrorFunction = (
  toolName: string,
  getPayload: (error: ToolInvocationError) => Readonly<Record<string, unknown>>,
): ((runContext: RunContext, error: unknown) => string) =>
  (_runContext: RunContext, error: unknown): string => {
    if (isInvalidToolInputError(error)) {
      return createToolErrorResult(toolName, getPayload(error));
    }

    return createToolErrorResult(toolName, {
      error: serializeToolError(error),
    });
  };

const createQueryDatabaseInvalidInputPayload = (): Readonly<Record<string, unknown>> => ({
  sql: null,
  error: {
    name: "InvalidToolInput",
    message: "query_database requires a string sql field",
  },
});

const createCaptureExtractedFileDataInvalidInputPayload = (
  error: ToolInvocationError,
): Readonly<Record<string, unknown>> => {
  const parsedInput = tryParseToolInputObject(error);
  const sourceFileName = readStringField(parsedInput, "sourceFileName");
  const sourceMediaType = readStringField(parsedInput, "sourceMediaType");
  const extractionFormatValue = parsedInput?.extractionFormat;

  let message = "capture_extracted_file_data received invalid input";
  if (sourceFileName === null) {
    message = "capture_extracted_file_data requires a non-empty string sourceFileName";
  } else if (sourceMediaType === null) {
    message = "capture_extracted_file_data requires a non-empty string sourceMediaType";
  } else if (!isCaptureExtractionFormat(extractionFormatValue)) {
    message = "capture_extracted_file_data requires extractionFormat to be one of: text, json, csv";
  } else if (typeof parsedInput?.rawData !== "string") {
    message = "capture_extracted_file_data requires a non-empty string rawData payload";
  } else if (
    parsedInput.extractionNotes !== undefined
    && parsedInput.extractionNotes !== null
    && typeof parsedInput.extractionNotes !== "string"
  ) {
    message = "capture_extracted_file_data accepts extractionNotes only as a string when provided";
  }

  return {
    ...(sourceFileName === null ? {} : { sourceFileName }),
    ...(sourceMediaType === null ? {} : { sourceMediaType }),
    ...(isCaptureExtractionFormat(extractionFormatValue) ? { extractionFormat: extractionFormatValue } : {}),
    error: {
      name: "InvalidToolInput",
      message,
    },
  };
};

export const pgQueryTool = tool({
  name: "query_database",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    sql: z.string().describe("SQL script to execute. One or more SELECT, WITH, INSERT, UPDATE, or DELETE statements separated by semicolons."),
  }),
  errorFunction: createInvalidToolInputErrorFunction(
    "query_database",
    createQueryDatabaseInvalidInputPayload,
  ),
  execute: async (
    input: Readonly<{ sql: string }>,
    runContext?: RunContext<AgentContext>,
  ): Promise<string> => {
    if (runContext === undefined) {
      throw new Error("pgQueryTool: missing run context");
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
    sourceFileName: z.string().describe("Original attached filename."),
    sourceMediaType: z.string().describe("Original attached media type."),
    extractionFormat: z.enum(["text", "json", "csv"]).describe("Raw extracted format: text, json, or csv."),
    rawData: z.string().describe("The complete raw extracted content."),
    extractionNotes: z.string().nullable().describe("Optional extraction notes or parser observations."),
  }),
  errorFunction: createInvalidToolInputErrorFunction(
    "capture_extracted_file_data",
    createCaptureExtractedFileDataInvalidInputPayload,
  ),
  execute: async (
    input: CaptureExtractedFileDataInput,
  ): Promise<string> => {
    if (input.sourceFileName.length === 0) {
      return createToolErrorResult("capture_extracted_file_data", {
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires a non-empty string sourceFileName",
        },
      });
    }

    if (input.sourceMediaType.length === 0) {
      return createToolErrorResult("capture_extracted_file_data", {
        error: {
          name: "InvalidToolInput",
          message: "capture_extracted_file_data requires a non-empty string sourceMediaType",
        },
      });
    }

    if (input.rawData.length === 0) {
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

    return createToolSuccessResult("capture_extracted_file_data", {
      sourceFileName: input.sourceFileName,
      sourceMediaType: input.sourceMediaType,
      extractionFormat: input.extractionFormat,
      rawData: input.rawData,
      extractionNotes: input.extractionNotes ?? null,
    });
  },
});
