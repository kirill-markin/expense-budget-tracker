"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { AccountMentionSuggestion } from "./accountMentions";
import type { AccountSuggestionsState } from "./useAccountSuggestions";
import styles from "./ChatPanel.module.css";

export const ACCOUNT_MENTION_LISTBOX_ID = "chat-account-mention-listbox";

export const getAccountMentionOptionId = (index: number): string =>
  `chat-account-mention-option-${index}`;

type PopoverPosition = Readonly<{
  top: number;
  insetInlineStart: number;
  width: number;
  maxHeight: number;
}>;

type Props = Readonly<{
  isOpen: boolean;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  loadStatus: AccountSuggestionsState["status"];
  suggestions: ReadonlyArray<AccountMentionSuggestion>;
  selectedIndex: number | null;
  listLabel: string;
  loadingLabel: string;
  unavailableLabel: string;
  onSelect: (suggestion: AccountMentionSuggestion) => void;
}>;

const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 6;

const getVisibleViewport = (): Readonly<{
  top: number;
  left: number;
  width: number;
}> => {
  const visualViewport = window.visualViewport;
  if (visualViewport === null) {
    return { top: 0, left: 0, width: window.innerWidth };
  }

  return {
    top: visualViewport.offsetTop,
    left: visualViewport.offsetLeft,
    width: visualViewport.width,
  };
};

export const AccountMentionPopover = (props: Props): ReactElement | null => {
  const {
    isOpen,
    anchorRef,
    loadStatus,
    suggestions,
    selectedIndex,
    listLabel,
    loadingLabel,
    unavailableLabel,
    onSelect,
  } = props;
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const updatePosition = useCallback((): void => {
    const anchor = anchorRef.current;
    if (anchor === null) {
      setPosition(null);
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const viewport = getVisibleViewport();
    const viewportInlineEnd = viewport.left + viewport.width;
    const availableWidth = Math.max(0, viewport.width - VIEWPORT_MARGIN_PX * 2);
    const width = Math.min(anchorRect.width, availableWidth);
    const minimumLeft = viewport.left + VIEWPORT_MARGIN_PX;
    const maximumLeft = viewportInlineEnd - VIEWPORT_MARGIN_PX - width;
    const left = Math.min(Math.max(anchorRect.left, minimumLeft), maximumLeft);
    const topBoundary = viewport.top + VIEWPORT_MARGIN_PX;
    const top = Math.max(topBoundary, anchorRect.top - ANCHOR_GAP_PX);
    const maxHeight = Math.max(0, top - topBoundary);
    const isRtl = getComputedStyle(anchor).direction === "rtl";
    const insetInlineStart = isRtl
      ? window.innerWidth - left - width
      : left;

    setPosition({ top, insetInlineStart, width, maxHeight });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [isOpen, loadStatus, suggestions, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleViewportChange = (): void => updatePosition();
    const resizeObserver = new ResizeObserver(handleViewportChange);
    const anchor = anchorRef.current;
    if (anchor !== null) {
      resizeObserver.observe(anchor);
    }

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
    };
  }, [anchorRef, isOpen, updatePosition]);

  if (!isOpen || position === null) {
    return null;
  }

  const style: CSSProperties = {
    top: position.top,
    insetInlineStart: position.insetInlineStart,
    inlineSize: position.width,
    maxBlockSize: position.maxHeight,
  };

  return createPortal(
    <div
      id={ACCOUNT_MENTION_LISTBOX_ID}
      className={styles.accountMentionPopover}
      data-testid="chat-account-mention-popover"
      role="listbox"
      aria-label={listLabel}
      style={style}
    >
      {loadStatus === "loading" && (
        <div className={styles.accountMentionState} role="status">
          {loadingLabel}
        </div>
      )}
      {loadStatus === "error" && (
        <div className={styles.accountMentionState} role="status">
          {unavailableLabel}
        </div>
      )}
      {loadStatus === "loaded" && suggestions.map((suggestion, index) => (
        <div
          key={`${suggestion.accountId}\u0000${suggestion.currency}`}
          id={getAccountMentionOptionId(index)}
          className={styles.accountMentionOption}
          data-testid="chat-account-mention-option"
          data-account-id={suggestion.accountId}
          role="option"
          aria-selected={selectedIndex === index}
          onPointerDown={(event: PointerEvent<HTMLDivElement>): void => {
            event.preventDefault();
            onSelect(suggestion);
          }}
        >
          <span className={styles.accountMentionAccountId}>{suggestion.accountId}</span>
          <span className={styles.accountMentionCurrency}>{suggestion.currency}</span>
        </div>
      ))}
    </div>,
    document.body,
  ) as ReactElement;
};
