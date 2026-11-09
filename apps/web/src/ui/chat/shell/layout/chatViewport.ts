"use client";

import { useSyncExternalStore } from "react";

type ChatViewport = "phone" | "overlay" | "docked" | "unresolved";

const subscribe = (onChange: () => void): (() => void) => {
  const phone = window.matchMedia("(max-width: 767px)");
  const docked = window.matchMedia("(min-width: 1100px)");
  phone.addEventListener("change", onChange);
  docked.addEventListener("change", onChange);
  return () => {
    phone.removeEventListener("change", onChange);
    docked.removeEventListener("change", onChange);
  };
};

const getSnapshot = (): ChatViewport => window.matchMedia("(max-width: 767px)").matches
  ? "phone"
  : window.matchMedia("(min-width: 1100px)").matches ? "docked" : "overlay";

const getServerSnapshot = (): ChatViewport => "unresolved";

export const useChatViewport = (): ChatViewport =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
