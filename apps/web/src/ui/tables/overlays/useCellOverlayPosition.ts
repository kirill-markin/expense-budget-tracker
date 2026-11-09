import { useEffect, useState, useSyncExternalStore } from "react";

import { resolveCellOverlayPosition, type CellRect, type OverlayViewport } from "./cellOverlayPosition";

const responsiveQuery = "(max-width: 1099px), (pointer: coarse)";
const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(responsiveQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const getSnapshot = (): boolean => window.matchMedia(responsiveQuery).matches;
const getServerSnapshot = (): boolean => false;

const readViewport = (): OverlayViewport => {
  if (typeof window === "undefined") return { top: 0, left: 0, width: 0, height: 0 };
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
};

/** Re-clamp the editor when the phone keyboard changes the visible viewport. */
export const useCellOverlayPosition = (rect: CellRect | null, minWidth: number, height: number, maxWidth = 680) => {
  const responsive = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [viewport, setViewport] = useState<OverlayViewport>(readViewport);
  useEffect(() => {
    if (rect === null || !responsive) return;
    const update = (): void => setViewport(readViewport());
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [rect, responsive]);
  if (rect === null || !responsive) return undefined;
  return resolveCellOverlayPosition(rect, viewport, minWidth, height, maxWidth, document.documentElement.dir === "rtl");
};
