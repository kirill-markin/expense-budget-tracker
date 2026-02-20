"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type CopyToastState = Readonly<{
  toastMessage: string | null;
  copyToClipboard: (text: string) => void;
}>;

const TOAST_DURATION_MS = 1500;

/**
 * Provides clipboard-copy with a brief toast notification.
 * Returns the current toast message (null when hidden) and a copy function.
 */
export const useCopyToast = (): CopyToastState => {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyToClipboard = useCallback((text: string): void => {
    navigator.clipboard.writeText(text).catch((error) => console.error(error));
    setToastMessage(`Copied: ${text}`);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToastMessage(null), TOAST_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { toastMessage, copyToClipboard };
};
