/**
 * One image or one PDF page of this chat's files, put in front of the model.
 *
 * The shell reads text, and a receipt photo, a chart or a scanned statement page
 * has none to read. This is the other half: the bytes reach the model as a
 * native `input_image` or `input_file` part, never as base64 inside a tool
 * result's text. The difference is measured and large - a native image costs
 * around 1,600 tokens where the same image as text costs 15,000-25,000 - and
 * nothing would fail on getting it wrong, which is why the part travels as a
 * part all the way through StoredChatFileViewReference.
 *
 * Images are read here and validated with the attachment image checks, so one
 * set of signature and size rules covers every image this app sends. A PDF page
 * is copied out by the sandbox, because the parsers deliberately do not exist in
 * the web image.
 *
 * Every ending that is a state of the chat or of its files is a refusal the model
 * can act on; an invocation or a read that failed is raised for the caller to
 * redact, exactly as the `bash` caller splits them.
 */
import { z } from "zod";
import {
  detectOpenAIImageMimeTypeFromFileName,
  normalizeOpenAIImageMimeType,
} from "@/lib/chatImageFormats";
import { getChatFileNameFromSandboxPath } from "@/lib/chatFiles";
import { PDF_MEDIA_TYPE } from "@/lib/chatPdf";
import {
  buildSandboxRequestFile,
  ChatSandboxResponseError,
  invokeSandboxFunction,
  invokeSandboxWithRetries,
  readChatSandboxFunctionName,
  SANDBOX_FILES_DIR,
  SANDBOX_WORK_DIR,
  type SandboxInvoking,
  type SandboxReadPresigning,
} from "@/server/chat/sandbox/invoke";
import {
  CHAT_ATTACHMENT_MAXIMUM_BYTES,
  validateChatAttachments,
} from "@/server/chat/attachments/validation";
import type {
  ChatFileViewPart,
  StoredChatFileViewReference,
} from "@/server/chat/openai/responses/replayItems";
import {
  buildChatFileObjectKey,
  getChatFilesObjectStoreIfConfigured,
} from "@/server/chatFiles/objectStore";
import { getChatFileByPath, type ChatFile } from "@/server/chatFiles/store";
import { log } from "@/server/logger";
import { quoteUntrustedSandboxValue } from "../../../../sandbox/src/contract";

export type ChatFileViewContext = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  /** Captured when the request arrived: a persisted run outlives it. */
  isDemoMode: boolean;
}>;

export type ChatFileViewDependencies = Readonly<
  SandboxReadPresigning & SandboxInvoking & {
    getChatFileByPath: typeof getChatFileByPath;
    readObjectBytes: (objectKey: string) => Promise<Uint8Array | null>;
    readFunctionName: () => string | null;
  }
>;

/** A view this chat declined, with the reason the model receives. */
export type ChatFileViewRefusal = Readonly<{
  code: string;
  message: string;
  instructions: string;
}>;

export type ChatFileView = Readonly<{
  /** The `input_text` part, which is also what the transcript records. */
  text: string;
  part: ChatFileViewPart;
  reference: StoredChatFileViewReference;
}>;

export type ChatFileViewResult =
  | Readonly<{ kind: "viewed"; view: ChatFileView }>
  | Readonly<{ kind: "refused"; refusal: ChatFileViewRefusal }>;

const USE_BASH_INSTRUCTIONS =
  `Read this file with bash instead: a document has a plain-text copy beside it, and ls -l ${SANDBOX_FILES_DIR} lists both.`;

const refuse = (
  code: string,
  message: string,
  instructions: string,
): ChatFileViewResult => ({ kind: "refused", refusal: { code, message, instructions } });

const pdfPageResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rendered"),
    page: z.number().int(),
    pageCount: z.number().int(),
    pdfBase64: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
]);

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const parsePdfPageResponse = (
  body: string,
): z.infer<typeof pdfPageResponseSchema> => {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch (error) {
    throw new ChatSandboxResponseError(
      `Chat sandbox pdf_page answered with a body that is not JSON: ${describeError(error)}`,
    );
  }
  const parsed = pdfPageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChatSandboxResponseError(
      `Chat sandbox pdf_page answer does not match its contract: ${parsed.error.message}`,
    );
  }

  return parsed.data;
};

/**
 * What this file can be shown as, or null when it cannot be shown at all.
 *
 * The row's media type decides for an upload, and the extension decides for a
 * /work file, whose media type is the opaque one every write slot is signed
 * with - so an image or a PDF the model itself produced is viewable under the
 * name it gave it.
 */
const classifyViewableChatFile = (
  file: ChatFile,
): Readonly<{ kind: "image"; mediaType: string }> | Readonly<{ kind: "pdf" }> | null => {
  const fileName = getChatFileNameFromSandboxPath(file.path);
  const claimedImageMediaType = normalizeOpenAIImageMimeType(file.mediaType);
  if (claimedImageMediaType !== null) {
    return { kind: "image", mediaType: claimedImageMediaType };
  }
  if (file.mediaType === PDF_MEDIA_TYPE) {
    return { kind: "pdf" };
  }
  const namedImageMediaType = detectOpenAIImageMimeTypeFromFileName(fileName);
  if (namedImageMediaType !== null) {
    return { kind: "image", mediaType: namedImageMediaType };
  }

  return fileName.toLowerCase().endsWith(".pdf") ? { kind: "pdf" } : null;
};

const buildReference = (
  file: ChatFile,
  page: number | null,
): StoredChatFileViewReference => ({
  fileId: file.fileId,
  path: file.path,
  sha256: file.sha256,
  page,
});

/**
 * One image, read and checked before it is sent.
 *
 * The checks are the attachment ones, called with the single part they describe:
 * the byte ceiling, the base64 shape, and the signature against the claimed
 * media type, which is what stops a `.png` that is really a HEIC from reaching
 * the model as a broken part. Their message names "content part 0", which is the
 * reused validator's own wording, and the refusal below names the path ahead of
 * it.
 */
const viewChatFileImage = async (
  file: ChatFile,
  mediaType: string,
  dependencies: ChatFileViewDependencies,
): Promise<ChatFileViewResult> => {
  const quotedPath = quoteUntrustedSandboxValue(file.path);
  if (file.sizeBytes > CHAT_ATTACHMENT_MAXIMUM_BYTES) {
    return refuse(
      "chat_file_not_viewable",
      `${quotedPath} is ${String(file.sizeBytes)} bytes, past the ${String(CHAT_ATTACHMENT_MAXIMUM_BYTES)} bytes one image may be shown as`,
      "Tell the user this image is too large to look at, and do not call view_file for it again.",
    );
  }

  const bytes = await dependencies.readObjectBytes(
    buildChatFileObjectKey(file.sessionId, file.fileId),
  );
  if (bytes === null) {
    return refuse(
      "chat_file_unavailable",
      `${quotedPath} is listed by this chat but its stored copy is gone, so it cannot be shown`,
      `Tell the user the file has to be attached again, and do not call view_file for it again. Everything else under ${SANDBOX_FILES_DIR} is unaffected.`,
    );
  }

  const base64Data = Buffer.from(bytes).toString("base64");
  try {
    validateChatAttachments([{ type: "image", mediaType, base64Data }]);
  } catch (error) {
    return refuse(
      "chat_file_not_viewable",
      `${quotedPath} is not an image this chat can show: ${describeError(error)}`,
      "Tell the user the file is not a supported image, and do not call view_file for it again.",
    );
  }

  return {
    kind: "viewed",
    view: {
      text: `${quotedPath}, ${mediaType}, ${String(bytes.byteLength)} bytes. The image follows this line.`,
      part: {
        type: "input_image",
        detail: "auto",
        image_url: `data:${mediaType};base64,${base64Data}`,
      },
      reference: buildReference(file, null),
    },
  };
};

/**
 * One PDF page, copied out by the sandbox and sent as a one-page PDF.
 *
 * A page rather than the document: handing the provider the whole file would
 * send every page of it on this turn and on every later turn that replays the
 * result. The page number is the model's, and a number outside the document is
 * answered by the sandbox with the real page count, which is the only way the
 * model learns which page it may ask for instead.
 */
const viewChatFilePdfPage = async (
  file: ChatFile,
  page: number,
  context: ChatFileViewContext,
  dependencies: ChatFileViewDependencies,
): Promise<ChatFileViewResult> => {
  const functionName = dependencies.readFunctionName();
  if (functionName === null) {
    return refuse(
      "chat_file_view_unavailable",
      "This deployment has no file sandbox configured, so a PDF page cannot be shown",
      "Do not call view_file for a PDF again in this chat. Answer from the attachment text in the conversation.",
    );
  }

  const payload = JSON.stringify({
    operation: "pdf_page",
    source: await buildSandboxRequestFile(file, dependencies),
    page,
  });
  const response = parsePdfPageResponse(
    await invokeSandboxWithRetries(functionName, payload, context, dependencies),
  );
  if (response.status === "failed") {
    return refuse(
      "chat_file_not_viewable",
      response.error,
      "Ask for a page the answer above says exists, or read the plain-text copy of this file with bash.",
    );
  }

  const fileName = getChatFileNameFromSandboxPath(file.path);

  return {
    kind: "viewed",
    view: {
      text: `${quoteUntrustedSandboxValue(file.path)}, page ${String(response.page)} of ${String(response.pageCount)}, as a one-page PDF of ${String(response.sizeBytes)} bytes. The page follows this line.`,
      part: {
        type: "input_file",
        filename: `page-${String(response.page)}-of-${fileName}`,
        file_data: `data:${PDF_MEDIA_TYPE};base64,${response.pdfBase64}`,
      },
      reference: buildReference(file, response.page),
    },
  };
};

const isViewablePath = (path: string): boolean =>
  path.startsWith(`${SANDBOX_FILES_DIR}/`) || path.startsWith(`${SANDBOX_WORK_DIR}/`);

export const viewChatFileWithDependencies = async (
  path: string,
  page: number | null,
  context: ChatFileViewContext,
  dependencies: ChatFileViewDependencies,
): Promise<ChatFileViewResult> => {
  // Demo mode serves in-memory data with no database and no bucket, so this
  // session owns no file to show.
  if (context.isDemoMode) {
    return refuse(
      "chat_file_view_unavailable",
      "Files are unavailable in demo mode, which has no file space",
      "Do not call view_file again in this chat. Answer from the demo data you can read with sql_query.",
    );
  }
  if (!isViewablePath(path)) {
    return refuse(
      "chat_file_not_found",
      `${quoteUntrustedSandboxValue(path)} is not a path of this chat: a file lives under ${SANDBOX_FILES_DIR}/ or ${SANDBOX_WORK_DIR}/`,
      `Run ls -l ${SANDBOX_FILES_DIR} and ls -l ${SANDBOX_WORK_DIR} with bash and call view_file with a path they list.`,
    );
  }

  const file = await dependencies.getChatFileByPath(
    context.userId,
    context.workspaceId,
    context.sessionId,
    path,
  );
  if (file === null) {
    return refuse(
      "chat_file_not_found",
      `This chat holds no file at ${quoteUntrustedSandboxValue(path)}`,
      `Run ls -l ${SANDBOX_FILES_DIR} and ls -l ${SANDBOX_WORK_DIR} with bash and call view_file with a path they list.`,
    );
  }
  // An unconfirmed row may have no object in the bucket at all, so without this
  // the read below answers "its stored copy is gone" - which tells the user to
  // attach the file again when the thing to do is wait for the upload that is
  // already running. Its own code, because that is the difference: this one
  // ends by itself and the other one never does.
  if (!file.isConfirmed) {
    return refuse(
      "chat_file_not_ready",
      `${quoteUntrustedSandboxValue(path)} is still being uploaded, so it cannot be shown yet`,
      "Tell the user the upload has not finished, and ask them to send the message again.",
    );
  }

  const viewable = classifyViewableChatFile(file);
  if (viewable === null) {
    return refuse(
      "chat_file_not_viewable",
      `${quoteUntrustedSandboxValue(path)} is ${file.mediaType}, which view_file does not show: it shows an image, or one page of a PDF`,
      USE_BASH_INSTRUCTIONS,
    );
  }
  if (viewable.kind === "image") {
    return page === null
      ? await viewChatFileImage(file, viewable.mediaType, dependencies)
      : refuse(
        "chat_file_not_viewable",
        `${quoteUntrustedSandboxValue(path)} is an image, which has no pages, so page ${String(page)} is not a thing to ask for`,
        "Call view_file again for the same path with page set to null.",
      );
  }

  return page === null
    ? refuse(
      "chat_file_not_viewable",
      `${quoteUntrustedSandboxValue(path)} is a PDF, and view_file shows one page of a PDF at a time`,
      `Call view_file again with the page you want, or read the whole file's plain-text copy with bash: ls -l ${SANDBOX_FILES_DIR} lists it beside the PDF.`,
    )
    : await viewChatFilePdfPage(file, page, context, dependencies);
};

let defaultDependencies: ChatFileViewDependencies | null = null;

export const buildChatFileViewDependencies = (): ChatFileViewDependencies => ({
  getChatFileByPath,
  readObjectBytes: async (objectKey: string): Promise<Uint8Array | null> => {
    // Null rather than a thrown configuration error: a deployment with no
    // bucket owns no chat file either, so the lookup above has already answered
    // and this is the ordering being made explicit rather than relied on.
    const store = getChatFilesObjectStoreIfConfigured();
    return store === null ? null : await store.readObjectBytes(objectKey);
  },
  presignReadUrl: async (
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ): Promise<string> => {
    const store = getChatFilesObjectStoreIfConfigured();
    if (store === null) {
      throw new Error("Chat files object store is not configured, so no file can be shown");
    }
    return await store.presignGetUrl(objectKey, downloadFileName, expiresInSeconds);
  },
  invokeSandbox: invokeSandboxFunction,
  readFunctionName: readChatSandboxFunctionName,
  log,
});

export const viewChatFile = async (
  path: string,
  page: number | null,
  context: ChatFileViewContext,
): Promise<ChatFileViewResult> => {
  defaultDependencies ??= buildChatFileViewDependencies();
  return await viewChatFileWithDependencies(path, page, context, defaultDependencies);
};
