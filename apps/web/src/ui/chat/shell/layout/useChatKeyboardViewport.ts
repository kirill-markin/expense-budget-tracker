"use client";

import { useEffect } from "react";

const KEYBOARD_HEIGHT_THRESHOLD_PX = 150;
const CHAT_TEXT_INPUT_SELECTOR = '[data-testid="chat-panel"] :is(textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], input[type="number"])';

export const useChatKeyboardViewport = (): void => {
  useEffect(() => {
    const root = document.documentElement;
    const pointer = window.matchMedia("(pointer: coarse)");
    const viewport = window.visualViewport;
    // Width, unlike the viewport's aspect ratio, does not change when a
    // landscape keyboard opens. Keep a separate baseline after rotation.
    const largestHeights = new Map<number, number>();
    let frame: number | null = null;

    const clearKeyboard = (): void => {
      root.removeAttribute("data-keyboard-open");
      root.removeAttribute("data-chat-viewport-overlay");
      root.style.removeProperty("--chat-viewport-height");
      root.style.removeProperty("--chat-viewport-offset-top");
    };

    const update = (): void => {
      frame = null;
      if (!pointer.matches) {
        clearKeyboard();
        return;
      }

      const height = viewport?.height ?? window.innerHeight;
      const width = window.innerWidth;
      const largestHeight = Math.max(
        largestHeights.get(width) ?? 0,
        window.innerHeight,
        height,
      );
      largestHeights.set(width, largestHeight);
      const focused = document.activeElement?.matches(CHAT_TEXT_INPUT_SELECTOR) === true;
      const isKeyboardOpen = focused
        && (viewport === null || viewport.scale === 1)
        && largestHeight - height > KEYBOARD_HEIGHT_THRESHOLD_PX;

      if (!isKeyboardOpen) {
        clearKeyboard();
        return;
      }

      root.setAttribute("data-keyboard-open", "true");
      root.style.setProperty("--chat-viewport-height", `${height}px`);
      // Safari pans its visual viewport without resizing the layout viewport.
      // Android's resizes-content path needs only the height, without fixing body.
      const overlaysLayout = window.innerHeight - height > 1;
      root.toggleAttribute("data-chat-viewport-overlay", overlaysLayout);
      root.style.setProperty("--chat-viewport-offset-top", `${viewport?.offsetTop ?? 0}px`);
      if (overlaysLayout && window.scrollY !== 0) {
        window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });
      }
    };

    const scheduleUpdate = (): void => {
      if (frame === null) frame = requestAnimationFrame(update);
    };

    update();
    document.addEventListener("focusin", scheduleUpdate);
    document.addEventListener("focusout", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    pointer.addEventListener("change", scheduleUpdate);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("focusin", scheduleUpdate);
      document.removeEventListener("focusout", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate);
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
      pointer.removeEventListener("change", scheduleUpdate);
      clearKeyboard();
    };
  }, []);
};
