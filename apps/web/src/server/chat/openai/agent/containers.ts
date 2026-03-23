import type { ModelResponse } from "@openai/agents-core";
import OpenAI from "openai";
import type { FileContentPart } from "@/server/chat/types";

type HostedToolCallOutputItem = Readonly<{
  type: "hosted_tool_call";
  name: string;
  providerData?: Readonly<{
    type?: string;
    container_id?: string;
    code?: string;
    outputs?: unknown;
  }>;
}>;

type OpenAIMessageOutputItem = Readonly<{
  type: "message";
  role?: string;
  content?: ReadonlyArray<Readonly<{
    type?: string;
    text?: string;
    annotations?: ReadonlyArray<Readonly<{
      filename?: string;
      path?: string;
      file_id?: string;
    }>>;
  }>>;
}>;

type SpreadsheetContainerRef = Readonly<{
  containerId: string;
  responseId?: string;
  requestId?: string;
}>;

type ContainerInventory = Readonly<{
  containerId: string;
  filePaths: ReadonlyArray<string>;
}>;

export type SpreadsheetContainerVerificationResult =
  | Readonly<{
    status: "missing_code_interpreter";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
  }>
  | Readonly<{
    status: "verified";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
    containerId: string;
    filePaths: ReadonlyArray<string>;
  }>
  | Readonly<{
    status: "verification_failed";
    attachmentFileNames: ReadonlyArray<string>;
    responseId?: string;
    requestId?: string;
    containerId: string;
    error: string;
  }>;

type OpenAIResponseSummary = Readonly<{
  finalOutputItemTypes: ReadonlyArray<string>;
  hasCodeInterpreterCall: boolean;
  codeInterpreterCallCount: number;
  codeSnippet: string | null;
  outputSummary: string | null;
  assistantTextSnippet: string | null;
  containerFileCitations: ReadonlyArray<string>;
}>;

const CODE_INTERPRETER_CONTAINER_PREFIX = "expense-chat";
const CODE_INTERPRETER_CONTAINER_MINUTES = 20;
const MAX_LOG_SNIPPET_LENGTH = 400;

const truncateForLog = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length <= MAX_LOG_SNIPPET_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_LOG_SNIPPET_LENGTH) + "...[truncated]";
};

const isHostedCodeInterpreterOutput = (
  item: ModelResponse["output"][number],
): item is HostedToolCallOutputItem =>
  item.type === "hosted_tool_call" &&
  item.name === "code_interpreter_call";

const getMessageOutputParts = (
  item: ModelResponse["output"][number],
): ReadonlyArray<NonNullable<OpenAIMessageOutputItem["content"]>[number]> => {
  if (item.type !== "message" || !("content" in item)) {
    return [];
  }
  const content = item.content;
  return Array.isArray(content)
    ? content as ReadonlyArray<NonNullable<OpenAIMessageOutputItem["content"]>[number]>
    : [];
};

export const buildOpenAIContainerName = (requestId: string): string =>
  `${CODE_INTERPRETER_CONTAINER_PREFIX}-${requestId}`;

export const isOpenAIContainerExpired = (
  container: Awaited<ReturnType<OpenAI["containers"]["retrieve"]>>,
): boolean => {
  const minutes = container.expires_after?.minutes ?? CODE_INTERPRETER_CONTAINER_MINUTES;
  const anchorSeconds = container.last_active_at ?? container.created_at;
  return Date.now() >= (anchorSeconds + minutes * 60) * 1000;
};

export const addFilesToOpenAIContainer = async (
  client: OpenAI,
  containerId: string,
  attachments: ReadonlyArray<FileContentPart>,
): Promise<void> => {
  for (const attachment of attachments) {
    const buffer = Buffer.from(attachment.base64Data, "base64");
    const file = new File([buffer], attachment.fileName, { type: attachment.mediaType });
    await client.containers.files.create(containerId, { file });
  }
};

export const extractCodeInterpreterContainers = (
  responses: ReadonlyArray<ModelResponse>,
): ReadonlyArray<SpreadsheetContainerRef> => {
  const containers = new Map<string, SpreadsheetContainerRef>();

  for (const response of responses) {
    for (const item of response.output) {
      if (!isHostedCodeInterpreterOutput(item)) {
        continue;
      }

      const containerId = item.providerData?.container_id;
      if (typeof containerId !== "string" || containerId.length === 0) {
        continue;
      }

      containers.set(containerId, {
        containerId,
        responseId: response.responseId,
        requestId: response.requestId,
      });
    }
  }

  return Array.from(containers.values());
};

export const listOpenAIContainerInventory = async (
  client: OpenAI,
  containerId: string,
): Promise<ContainerInventory> => {
  const files = await client.containers.files.list(containerId, { order: "asc" });
  return {
    containerId,
    filePaths: files.data.map((file) => file.path),
  };
};

export const verifySpreadsheetContainers = async (
  client: OpenAI,
  responses: ReadonlyArray<ModelResponse>,
  spreadsheetAttachmentFileNames: ReadonlyArray<string>,
): Promise<ReadonlyArray<SpreadsheetContainerVerificationResult>> => {
  const containers = extractCodeInterpreterContainers(responses);
  const latestResponse = responses.at(-1);

  if (containers.length === 0) {
    return [{
      status: "missing_code_interpreter",
      attachmentFileNames: spreadsheetAttachmentFileNames,
      responseId: latestResponse?.responseId,
      requestId: latestResponse?.requestId,
    }];
  }

  const results: Array<SpreadsheetContainerVerificationResult> = [];
  for (const container of containers) {
    try {
      const inventory = await listOpenAIContainerInventory(client, container.containerId);
      results.push({
        status: "verified",
        attachmentFileNames: spreadsheetAttachmentFileNames,
        responseId: container.responseId,
        requestId: container.requestId,
        containerId: container.containerId,
        filePaths: inventory.filePaths,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        status: "verification_failed",
        attachmentFileNames: spreadsheetAttachmentFileNames,
        responseId: container.responseId,
        requestId: container.requestId,
        containerId: container.containerId,
        error: errorMessage,
      });
    }
  }

  return results;
};

export const summarizeOpenAIResponse = (
  responses: ReadonlyArray<ModelResponse>,
  finalOutput: string | undefined,
): OpenAIResponseSummary => {
  const latestResponse = responses.at(-1);
  if (latestResponse === undefined) {
    return {
      finalOutputItemTypes: [],
      hasCodeInterpreterCall: false,
      codeInterpreterCallCount: 0,
      codeSnippet: null,
      outputSummary: null,
      assistantTextSnippet: truncateForLog(finalOutput),
      containerFileCitations: [],
    };
  }

  const finalOutputItemTypes = latestResponse.output.map((item) => item.type ?? "unknown");
  const codeInterpreterCalls = latestResponse.output.filter(isHostedCodeInterpreterOutput);
  const firstCodeInterpreterCall = codeInterpreterCalls[0];
  const outputSummary = firstCodeInterpreterCall === undefined
    ? null
    : truncateForLog(
      JSON.stringify(
        (firstCodeInterpreterCall.providerData as { outputs?: unknown } | undefined)?.outputs ?? null,
      ),
    );

  const messageTextParts = latestResponse.output
    .flatMap(getMessageOutputParts)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "");
  const containerFileCitations = latestResponse.output
    .flatMap(getMessageOutputParts)
    .flatMap((part) => part.annotations ?? [])
    .map((annotation) => annotation.path ?? annotation.filename ?? annotation.file_id ?? JSON.stringify(annotation));

  return {
    finalOutputItemTypes,
    hasCodeInterpreterCall: codeInterpreterCalls.length > 0,
    codeInterpreterCallCount: codeInterpreterCalls.length,
    codeSnippet: truncateForLog(firstCodeInterpreterCall?.providerData?.code),
    outputSummary,
    assistantTextSnippet: truncateForLog(finalOutput ?? messageTextParts.join("")),
    containerFileCitations,
  };
};
