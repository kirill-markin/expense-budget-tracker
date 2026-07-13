"use client";

import { useRef, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  detectOpenAIImageMimeTypeFromFileName,
  getFileExtension,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  normalizeOpenAIImageMimeType,
} from "@/lib/chatImageFormats";
import {
  CHAT_IMAGE_PREPROCESSING_CONSTRAINTS,
  preprocessImageAttachment,
  UnsupportedImageFormatError,
} from "../../attachments/imagePreprocessing";
import styles from "./ChatPanel.module.css";
import {
  AttachmentReadError,
  hasSupportedImageAttachmentSignature,
} from "./chatPanelRuntime";

export type PendingAttachment = Readonly<{
  fileName: string;
  mediaType: string;
  base64Data: string;
}>;

type Props = Readonly<{
  onIngestFiles: (files: ReadonlyArray<File>) => Promise<number>;
  disabled?: boolean;
}>;

const DOCUMENT_FILE_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".csv",
  ".json",
  ".xml",
  ".xlsx",
  ".xls",
  ".md",
  ".html",
  ".py",
  ".js",
  ".ts",
  ".yaml",
  ".yml",
  ".sql",
  ".log",
  ".docx",
] as const;
const DOCUMENT_FILE_EXTENSION_SET = new Set<string>(DOCUMENT_FILE_EXTENSIONS);
const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/*",
  ".heic",
  ".heif",
  ...DOCUMENT_FILE_EXTENSIONS,
].join(",");

export const MAX_FILE_SIZE_BYTES = CHAT_IMAGE_PREPROCESSING_CONSTRAINTS.maximumSourceBytes;

export const checkFileSize = (file: File): string | null => {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return `File "${file.name}" is too large (${sizeMb} MB). Maximum allowed size is ${limitMb} MB.`;
  }
  return null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise<string>((resolve, reject): void => {
    const reader = new FileReader();
    reader.onload = (): void => {
      if (typeof reader.result !== "string") {
        reject(new AttachmentReadError(file.name, "FileReader returned a non-string result"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex < 0) {
        reject(new AttachmentReadError(file.name, "FileReader returned an invalid data URL"));
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.onerror = (): void => {
      reject(new AttachmentReadError(file.name, errorMessage(reader.error)));
    };
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      reject(new AttachmentReadError(file.name, errorMessage(error)));
    }
  });

const isImageAttachment = (file: File): boolean =>
  file.type.trim().toLowerCase().startsWith("image/")
  || detectOpenAIImageMimeTypeFromFileName(file.name) !== null
  || isHeicFileExtension(file.name);

export const isSupportedClipboardImage = (file: File): boolean =>
  normalizeOpenAIImageMimeType(file.type) !== null
  || normalizeHeicImageMimeType(file.type) !== null
  || detectOpenAIImageMimeTypeFromFileName(file.name) !== null
  || isHeicFileExtension(file.name);

export const isAmbiguousClipboardFile = (file: File): boolean => {
  const normalizedMediaType = file.type.trim().toLowerCase();
  return normalizedMediaType === ""
    || normalizedMediaType === "application/octet-stream";
};

const getClipboardImageExtension = (mediaType: string): string => {
  const openAIType = normalizeOpenAIImageMimeType(mediaType);
  if (openAIType === "image/png") return ".png";
  if (openAIType === "image/jpeg") return ".jpg";
  if (openAIType === "image/gif") return ".gif";
  if (openAIType === "image/webp") return ".webp";

  const heicType = normalizeHeicImageMimeType(mediaType);
  if (heicType === "image/heif" || heicType === "image/heif-sequence") {
    return ".heif";
  }
  if (heicType === "image/heic" || heicType === "image/heic-sequence") {
    return ".heic";
  }

  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (normalizedMediaType === "" || normalizedMediaType === "application/octet-stream") {
    return "";
  }

  throw new TypeError(`Unsupported clipboard image MIME type: ${mediaType}`);
};

export const normalizeClipboardImageFile = (file: File, index: number): File => {
  if (file.name.trim() !== "") {
    return file;
  }

  const sequenceSuffix = index === 0 ? "" : `-${index + 1}`;
  return new File(
    [file],
    `clipboard-image${sequenceSuffix}${getClipboardImageExtension(file.type)}`,
    { type: file.type, lastModified: file.lastModified },
  );
};

export const prepareAttachment = async (file: File): Promise<PendingAttachment> => {
  const sizeError = checkFileSize(file);
  if (sizeError !== null) {
    throw new RangeError(sizeError);
  }

  if (isImageAttachment(file) || await hasSupportedImageAttachmentSignature(file)) {
    return preprocessImageAttachment(file, CHAT_IMAGE_PREPROCESSING_CONSTRAINTS);
  }

  if (
    isAmbiguousClipboardFile(file)
    && !DOCUMENT_FILE_EXTENSION_SET.has(getFileExtension(file.name))
  ) {
    throw new UnsupportedImageFormatError(file.name, file.type);
  }

  const base64Data = await readFileAsBase64(file);
  return { fileName: file.name, mediaType: file.type || "application/octet-stream", base64Data };
};

export const FileAttachment = (props: Props): ReactElement => {
  const { onIngestFiles, disabled } = props;
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.currentTarget.files ?? []);

    // Reset input so the same file can be attached again
    event.currentTarget.value = "";
    await onIngestFiles(files);
  };

  return (
    <>
      <input
        ref={inputRef}
        data-testid="chat-file-input"
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        style={{ display: "none" }}
        disabled={disabled}
        onChange={(event) => void handleChange(event)}
      />
      <button
        type="button"
        className={styles.attachButton}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {t("chat.attach")}
      </button>
    </>
  );
};
