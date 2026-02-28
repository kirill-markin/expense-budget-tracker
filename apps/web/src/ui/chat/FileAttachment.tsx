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

export const readFileAsBase64 = (file: File): Promise<string> =>
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
      const base64Data = await readFileAsBase64(file);
      onAttach({
        fileName: file.name,
        mediaType: file.type || "application/octet-stream",
        base64Data,
      });
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
