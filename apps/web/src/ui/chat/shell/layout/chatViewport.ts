"use client";

import { useSyncExternalStore } from "react";

type ChatViewport = "phone" | "overlay" | "docked" | "unresolved";

const PHONE_QUERY = "(width < 768px)";
const DOCKED_QUERY = "(min-width: 1100px) and (pointer: fine)";

const subscribe = (onChange: () => void): (() => void) => {
  const phone = window.matchMedia(PHONE_QUERY);
  const docked = window.matchMedia(DOCKED_QUERY);
  phone.addEventListener("change", onChange);
  docked.addEventListener("change", onChange);
  return () => {
    phone.removeEventListener("change", onChange);
    docked.removeEventListener("change", onChange);
  };
};

const getSnapshot = (): ChatViewport => window.matchMedia(PHONE_QUERY).matches
  ? "phone"
  : window.matchMedia(DOCKED_QUERY).matches ? "docked" : "overlay";

const getServerSnapshot = (): ChatViewport => "unresolved";

export const useChatViewport = (): ChatViewport =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
