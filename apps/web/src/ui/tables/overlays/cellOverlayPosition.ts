export type CellRect = Readonly<{ top: number; left: number; width: number; height: number }>;
export type OverlayViewport = Readonly<{ top: number; left: number; width: number; height: number }>;

/** DOMRects and fixed overlays use physical coordinates, even in RTL. */
export const resolveCellOverlayPosition = (
  rect: CellRect,
  viewport: OverlayViewport,
  minWidth: number,
  preferredHeight: number,
  maxWidth: number,
  isRtl: boolean,
): Readonly<{ top: number; left: number; width: number; maxHeight: number }> => {
  const gap = 8;
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth, Math.max(1, viewport.width - gap * 2));
  const height = Math.min(preferredHeight, Math.max(1, viewport.height - gap * 2));
  const minLeft = viewport.left + gap;
  const minTop = viewport.top + gap;
  const preferredLeft = isRtl ? rect.left + rect.width - width : rect.left;
  return {
    top: Math.max(minTop, Math.min(rect.top, viewport.top + viewport.height - height - gap)),
    left: Math.max(minLeft, Math.min(preferredLeft, viewport.left + viewport.width - width - gap)),
    width,
    maxHeight: height,
  };
};
