import Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import { CODE_INTERPRETER_CONTAINER_HEADER_NAME } from "@/lib/chatSession";
import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  FileContentPart,
  TextContentPart,
  ImageContentPart,
} from "@/server/chat/types";
import {
  buildSystemInstructions,
  extractText,
  summarizeContent,
} from "@/server/chat/shared";
import { log } from "@/server/logger";
import { CODE_EXECUTION_TOOL, DB_TOOL, executeTool } from "./tools";

type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

type StartAgentResponseResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  responseHeaders?: Readonly<Record<string, string>>;
}>;

type ToolUseLikeBlock = Readonly<{
  type: "tool_use" | "server_tool_use";
  id: string;
  name: string;
  input: unknown;
}>;

type CodeExecutionResultContent = Readonly<{
  type: string;
  stdout?: string;
  stderr?: string;
  return_code?: number;
  error_code?: string;
  content?: ReadonlyArray<Readonly<{ file_id?: string; type?: string }>>;
}>;

type CodeExecutionResultBlock = Readonly<{
  type: string;
  content: CodeExecutionResultContent;
}>;

const MAX_TOKENS = 8192;
const MAX_TURNS = 10;
const FILES_BETA = "files-api-2025-04-14" as const;
const MAX_LOG_SNIPPET_LENGTH = 400;

const SPREADSHEET_MEDIA_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
]);

export type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
  timezone: string;
  chatSessionId: string;
  codeInterpreterContainerId: string | null;
}>;

const buildAnthropicInstructions = (timezone: string, hasPersistentContainer: boolean): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code execution tool for calculations, charts, and file analysis. Use it when appropriate." +
  "\nIf the user attaches a CSV or spreadsheet file, inspect it with code execution before claiming the file is unavailable." +
  (hasPersistentContainer
    ? "\nFiles previously attached earlier in this same chat remain available through code execution while the current container is active."
    : "");

const truncateForLog = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length <= MAX_LOG_SNIPPET_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_LOG_SNIPPET_LENGTH) + "...[truncated]";
};

const getLastUserMessage = (
  messages: ReadonlyArray<ChatMessage>,
): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i];
    }
  }
  return null;
};

export const getLatestUserFileAttachments = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (lastUserMessage === null) {
    return [];
  }
  return lastUserMessage.content.filter((part): part is FileContentPart => part.type === "file");
};

const getFileExtension = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
};

const isSpreadsheetAttachment = (part: FileContentPart): boolean =>
  SPREADSHEET_MEDIA_TYPES.has(part.mediaType) || SPREADSHEET_EXTENSIONS.has(getFileExtension(part.fileName));

const getSpreadsheetAttachmentFileNames = (
  attachments: ReadonlyArray<FileContentPart>,
): ReadonlyArray<string> =>
  attachments.filter(isSpreadsheetAttachment).map((part) => part.fileName);

const isUploadableFile = (part: ContentPart): part is FileContentPart =>
  part.type === "file" && part.mediaType !== "application/pdf";

export const getLatestUserUploadableFiles = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (lastUserMessage === null) {
    return [];
  }
  return lastUserMessage.content.filter(isUploadableFile);
};

const uploadFiles = async (
  client: Anthropic,
  uploadParts: ReadonlyArray<FileContentPart>,
  chatSessionId: string,
  codeInterpreterContainerId: string | null,
): Promise<Map<string, string>> => {
  const fileIds = new Map<string, string>();

  for (const part of uploadParts) {
    const buffer = Buffer.from(part.base64Data, "base64");
    const file = await toFile(buffer, part.fileName, { type: part.mediaType });
    const metadata = await client.beta.files.upload({
      file,
      betas: [FILES_BETA],
    });
    fileIds.set(part.fileName, metadata.id);
    log({
      domain: "chat",
      action: "code_interpreter_container_file_added",
      vendor: "anthropic",
      chatSessionId,
      codeInterpreterContainerId,
      effectiveContainerId: codeInterpreterContainerId,
      attachmentFileName: part.fileName,
      providerFileId: metadata.id,
    });
  }

  return fileIds;
};

const mapUserPart = (
  part: TextContentPart | ImageContentPart | FileContentPart,
  fileIds: Map<string, string>,
): BetaContentBlockParam => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: part.base64Data,
        },
      };
    case "file": {
      if (part.mediaType === "application/pdf") {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: part.base64Data,
          },
          title: part.fileName,
        };
      }
      const fileId = fileIds.get(part.fileName);
      if (fileId !== undefined) {
        return { type: "container_upload", file_id: fileId };
      }
      return {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: Buffer.from(part.base64Data, "base64").toString("utf-8"),
        },
        title: part.fileName,
      };
    }
  }
};

const buildMessages = (
  messages: ReadonlyArray<ChatMessage>,
  fileIds: Map<string, string>,
): Array<BetaMessageParam> => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: Array<BetaMessageParam> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: [{ type: "text", text: extractText(msg.content) }],
      });
      continue;
    }

    const hasAttachments = msg.content.some((p) => p.type !== "text");

    if (!hasAttachments) {
      const text = extractText(msg.content);
      result.push({ role: "user", content: text });
      continue;
    }

    if (i === lastUserIdx) {
      result.push({
        role: "user",
        content: msg.content
          .filter((p): p is TextContentPart | ImageContentPart | FileContentPart => p.type !== "tool_call")
          .map((p) => mapUserPart(p, fileIds)),
      });
    } else {
      result.push({ role: "user", content: summarizeContent(msg.content) });
    }
  }
  return result;
};

const CODE_EXECUTION_RESULT_TYPES = new Set([
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
]);

const blockToParam = (block: BetaContentBlock): BetaContentBlockParam => {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  if (block.type === "server_tool_use") {
    return {
      type: "server_tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  if (block.type === "web_search_tool_result") {
    return block as unknown as BetaContentBlockParam;
  }
  if (CODE_EXECUTION_RESULT_TYPES.has(block.type)) {
    return block as unknown as BetaContentBlockParam;
  }
  return { type: "text", text: "" };
};

const isToolUseLikeBlock = (block: BetaContentBlock): boolean =>
  block.type === "tool_use" || block.type === "server_tool_use";

const isCodeExecutionResultBlock = (block: BetaContentBlock): boolean =>
  CODE_EXECUTION_RESULT_TYPES.has(block.type);

const getErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

const classifyAnthropicContainerError = (
  error: unknown,
): "code_interpreter_container_not_found" | "code_interpreter_container_expired" | null => {
  if (getErrorStatus(error) === 404) {
    return "code_interpreter_container_not_found";
  }
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (errorMessage.includes("expire")) {
    return "code_interpreter_container_expired";
  }
  if (errorMessage.includes("container") && errorMessage.includes("not found")) {
    return "code_interpreter_container_not_found";
  }
  return null;
};

export const shouldRetryAnthropicContainerRun = (
  hasYieldedContent: boolean,
  codeInterpreterContainerId: string | null,
): boolean => !hasYieldedContent && codeInterpreterContainerId !== null;

const summarizeCodeExecutionResult = (
  block: CodeExecutionResultBlock,
): string => {
  const content = block.content;
  return JSON.stringify({
    type: block.type,
    resultType: content.type,
    returnCode: content.return_code ?? null,
    stdout: truncateForLog(content.stdout) ?? "",
    stderr: truncateForLog(content.stderr) ?? "",
    errorCode: content.error_code ?? null,
    outputFileIds: content.content?.map((item) => item.file_id ?? null) ?? [],
  });
};

export const summarizeAnthropicResponse = (
  finalMessage: Readonly<{
    content: ReadonlyArray<BetaContentBlock>;
    stop_reason: string | null;
  }>,
): Readonly<{
  finalOutputItemTypes: ReadonlyArray<string>;
  hasCodeInterpreterCall: boolean;
  codeInterpreterCallCount: number;
  codeSnippet: string | null;
  outputSummary: string | null;
  assistantTextSnippet: string | null;
  stopReason: string;
}> => {
  const finalOutputItemTypes = finalMessage.content.map((block) => block.type);
  const codeExecutionCalls = finalMessage.content.reduce<Array<ToolUseLikeBlock>>((result, block) => {
    if (!isToolUseLikeBlock(block)) {
      return result;
    }
    const toolBlock = block as ToolUseLikeBlock;
    if (toolBlock.name === "code_execution") {
      result.push(toolBlock);
    }
    return result;
  }, []);
  const codeExecutionResults = finalMessage.content.reduce<Array<CodeExecutionResultBlock>>((result, block) => {
    if (isCodeExecutionResultBlock(block)) {
      result.push(block as CodeExecutionResultBlock);
    }
    return result;
  }, []);
  const codeSnippet = codeExecutionCalls.length === 0
    ? null
    : truncateForLog(JSON.stringify(codeExecutionCalls[0].input));
  const outputSummaryValue = codeExecutionResults.map(summarizeCodeExecutionResult).join("\n");
  const assistantText = finalMessage.content
    .filter((block): block is Extract<BetaContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    finalOutputItemTypes,
    hasCodeInterpreterCall: codeExecutionCalls.length > 0 || codeExecutionResults.length > 0,
    codeInterpreterCallCount: codeExecutionCalls.length > 0 ? codeExecutionCalls.length : codeExecutionResults.length,
    codeSnippet,
    outputSummary: outputSummaryValue.length === 0 ? null : truncateForLog(outputSummaryValue),
    assistantTextSnippet: truncateForLog(assistantText),
    stopReason: finalMessage.stop_reason ?? "unknown",
  };
};

export const startAgentResponse = async (
  params: StreamAgentParams,
): Promise<StartAgentResponseResult> => {
  const client = new Anthropic();
  const requestStart = Date.now();
  const latestFileAttachments = getLatestUserFileAttachments(params.messages);
  const uploadableFiles = getLatestUserUploadableFiles(params.messages);
  const attachmentFileNames = latestFileAttachments.map((part) => part.fileName);
  const attachmentMediaTypes = latestFileAttachments.map((part) => part.mediaType);
  const spreadsheetAttachmentFileNames = getSpreadsheetAttachmentFileNames(latestFileAttachments);
  const hasAttachments = params.messages.some((message) =>
    message.content.some((part) => part.type !== "text"),
  );
  const fileIds = await uploadFiles(
    client,
    uploadableFiles,
    params.chatSessionId,
    params.codeInterpreterContainerId,
  );

  log({
    domain: "chat",
    action: "request",
    vendor: "anthropic",
    model: params.model,
    chatSessionId: params.chatSessionId,
    messageCount: params.messages.length,
    hasAttachments,
    attachmentCount: latestFileAttachments.length,
    attachmentFileNames,
    attachmentMediaTypes,
    spreadsheetAttachmentFileNames,
    codeInterpreterContainerId: params.codeInterpreterContainerId,
  });

  const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
    let currentContainerId = params.codeInterpreterContainerId;
    let hasRetriedWithoutContainer = false;

    while (true) {
      const messages = buildMessages(params.messages, fileIds);
      let completedTurns = 0;
      let hasYieldedContent = false;

      if (currentContainerId !== null) {
        log({
          domain: "chat",
          action: "code_interpreter_container_reused",
          vendor: "anthropic",
          chatSessionId: params.chatSessionId,
          codeInterpreterContainerId: params.codeInterpreterContainerId,
          effectiveContainerId: currentContainerId,
        });
      }

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          log({ domain: "chat", action: "turn_start", vendor: "anthropic", turn });
          const stream = client.beta.messages.stream({
            model: params.model,
            max_tokens: MAX_TOKENS,
            system: buildAnthropicInstructions(params.timezone, currentContainerId !== null),
            messages,
            tools: [
              DB_TOOL,
              CODE_EXECUTION_TOOL,
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: 5,
              },
            ],
            betas: [FILES_BETA],
            container: currentContainerId,
          });

          for await (const event of stream) {
            if (event.type === "content_block_start") {
              if (event.content_block.type === "tool_use") {
                hasYieldedContent = true;
                yield { type: "tool_call", name: event.content_block.name, status: "started" };
              }
              if (event.content_block.type === "server_tool_use") {
                hasYieldedContent = true;
                yield { type: "tool_call", name: event.content_block.name, status: "started" };
              }
              if (event.content_block.type === "web_search_tool_result") {
                hasYieldedContent = true;
                yield { type: "tool_call", name: "web_search", status: "completed" };
              }
            }

            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              hasYieldedContent = true;
              yield { type: "delta", text: event.delta.text };
            }
          }

          const finalMessage = await stream.finalMessage();
          const effectiveContainerId = finalMessage.container?.id ?? currentContainerId ?? null;
          if (
            effectiveContainerId !== null
            && effectiveContainerId !== params.codeInterpreterContainerId
          ) {
            yield { type: "container_id", containerId: effectiveContainerId };
          }

          if (effectiveContainerId !== null && currentContainerId === null) {
            log({
              domain: "chat",
              action: hasRetriedWithoutContainer
                ? "code_interpreter_container_recreated"
                : "code_interpreter_container_created",
              vendor: "anthropic",
              chatSessionId: params.chatSessionId,
              codeInterpreterContainerId: params.codeInterpreterContainerId,
              effectiveContainerId,
            });
          }

          currentContainerId = effectiveContainerId;
          messages.push({
            role: "assistant",
            content: finalMessage.content.map(blockToParam),
          });

          for (const block of finalMessage.content) {
            if (CODE_EXECUTION_RESULT_TYPES.has(block.type)) {
              hasYieldedContent = true;
              yield { type: "tool_call", name: "code_execution", status: "completed" };
            }
          }

          completedTurns = turn + 1;

          if (finalMessage.stop_reason !== "tool_use") {
            const responseSummary = summarizeAnthropicResponse(finalMessage);
            log({
              domain: "chat",
              action: "response_summary",
              vendor: "anthropic",
              chatSessionId: params.chatSessionId,
              codeInterpreterContainerId: currentContainerId,
              finalOutputItemTypes: responseSummary.finalOutputItemTypes,
              hasCodeInterpreterCall: responseSummary.hasCodeInterpreterCall,
              codeInterpreterCallCount: responseSummary.codeInterpreterCallCount,
              codeSnippet: responseSummary.codeSnippet,
              outputSummary: responseSummary.outputSummary,
              assistantTextSnippet: responseSummary.assistantTextSnippet,
              stopReason: responseSummary.stopReason,
            });
            log({
              domain: "chat",
              action: "response",
              vendor: "anthropic",
              turns: completedTurns,
              stopReason: responseSummary.stopReason,
              durationMs: Date.now() - requestStart,
            });
            yield { type: "done" };
            return;
          }

          const toolResults: Array<Anthropic.Beta.Messages.BetaToolResultBlockParam> = [];
          for (const block of finalMessage.content) {
            if (block.type === "tool_use") {
              log({ domain: "chat", action: "tool_call", vendor: "anthropic", tool: block.name, status: "started" });
              const toolStart = Date.now();
              const result = await executeTool(
                block.id,
                block.name,
                block.input,
                params.userId,
                params.workspaceId,
              );
              const toolStatus = result.is_error ? "error" : "completed";
              log({
                domain: "chat",
                action: "tool_call",
                vendor: "anthropic",
                tool: block.name,
                status: toolStatus,
                durationMs: Date.now() - toolStart,
              });
              toolResults.push(result);
              const toolOutput = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
              hasYieldedContent = true;
              yield {
                type: "tool_call",
                name: block.name,
                status: "completed",
                input: JSON.stringify(block.input),
                output: toolOutput,
              };
            }
          }

          messages.push({ role: "user", content: toolResults });
        }

        log({
          domain: "chat",
          action: "response",
          vendor: "anthropic",
          turns: completedTurns,
          stopReason: "max_turns",
          durationMs: Date.now() - requestStart,
        });
        yield { type: "done" };
        return;
      } catch (error) {
        if (shouldRetryAnthropicContainerRun(hasYieldedContent, currentContainerId)) {
          const classification = classifyAnthropicContainerError(error);
          if (classification !== null) {
            log({
              domain: "chat",
              action: classification,
              vendor: "anthropic",
              chatSessionId: params.chatSessionId,
              codeInterpreterContainerId: params.codeInterpreterContainerId,
              effectiveContainerId: currentContainerId,
            });
          }
          hasRetriedWithoutContainer = true;
          currentContainerId = null;
          continue;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        log({ domain: "chat", action: "error", vendor: "anthropic", error: errorMessage });
        throw error;
      }
    }
  })();

  return {
    events,
    responseHeaders: params.codeInterpreterContainerId === null
      ? undefined
      : { [CODE_INTERPRETER_CONTAINER_HEADER_NAME]: params.codeInterpreterContainerId },
  };
};
