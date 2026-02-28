"use client";

import { useRef, type ReactElement } from "react";

export type PendingAttachment = Readonly<{
  fileName: string;
  mediaType: string;
  base64Data: string;
}>;

type Props = Readonly<{
  onAttach: (attachment: PendingAttachment) => void;
}>;

const ACCEPTED_TYPES = "image/*,.pdf,.txt,.csv,.json,.xml,.xlsx,.xls,.md,.html,.py,.js,.ts,.yaml,.yml,.sql,.log,.docx";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export const checkFileSize = (file: File): string | null => {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return `File "${file.name}" is too large (${sizeMb} MB). Maximum allowed size is ${limitMb} MB.`;
  }
  return null;
};

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:...;base64, prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const IMAGE_COMPRESS_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const compressImage = (file: File): Promise<{ base64Data: string; mediaType: string }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        reject(new Error(`Canvas 2D context unavailable — cannot compress image: ${file.name}`));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const base64 = dataUrl.split(",")[1];
      resolve({ base64Data: base64, mediaType: "image/jpeg" });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to load image: ${file.name}`));
    };

    img.src = url;
  });

export const prepareAttachment = async (file: File): Promise<PendingAttachment> => {
  if (IMAGE_COMPRESS_TYPES.has(file.type)) {
    const { base64Data, mediaType } = await compressImage(file);
    return { fileName: file.name, mediaType, base64Data };
  }
  const base64Data = await readFileAsBase64(file);
  return { fileName: file.name, mediaType: file.type || "application/octet-stream", base64Data };
};

export const FileAttachment = (props: Props): ReactElement => {
  const { onAttach } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = async (): Promise<void> => {
    const files = inputRef.current?.files;
    if (files === null || files === undefined) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sizeError = checkFileSize(file);
      if (sizeError !== null) {
        alert(sizeError);
        continue;
      }
      const attachment = await prepareAttachment(file);
      onAttach(attachment);
    }

    // Reset input so the same file can be attached again
    if (inputRef.current !== null) {
      inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        style={{ display: "none" }}
        onChange={() => void handleChange()}
      />
      <button
        type="button"
        className="chat-attach-btn"
        onClick={() => inputRef.current?.click()}
      >
        Attach
      </button>
    </>
  );
};
