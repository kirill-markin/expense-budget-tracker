"use client";

import { useSyncExternalStore, type ReactElement } from "react";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { useChatLayout } from "./ChatLayoutProvider";
import styles from "../panel/ChatPanel.module.css";

const subscribeToPointer = (onChange: () => void): (() => void) => {
  const media = window.matchMedia("(pointer: coarse)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const isCoarsePointer = (): boolean => window.matchMedia("(pointer: coarse)").matches;
const getServerPointer = (): boolean => false;

type Props = Readonly<{ placement?: "floating" | "header" }>;

export const ChatToggle = ({ placement = "floating" }: Props): ReactElement | null => {
  const { t } = useTranslation();
  const { isOpen, setIsOpen } = useChatLayout();
  const pathname = usePathname();
  const isHeader = placement === "header";
  const coarsePointer = useSyncExternalStore(subscribeToPointer, isCoarsePointer, getServerPointer);
  if (!isHeader && coarsePointer) return null;
  if (isHeader && pathname === "/chat") return null;

  return (
    <button
      type="button"
      id={isHeader ? "chat-header-toggle" : undefined}
      data-testid={isHeader ? "chat-header-toggle" : "chat-sidebar-open"}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-controls="chat-sidebar"
      className={isHeader ? styles.toggleHeader : styles.toggleFloating}
      onClick={() => setIsOpen(!isOpen)}
    >
      {t("chat.title")}
    </button>
  );
};
