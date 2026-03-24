export type AutoScrollPinnedStateInput = Readonly<{
  isPinned: boolean;
  previousScrollTop: number;
  currentScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}>;

export const AUTO_SCROLL_RELEASE_DISTANCE_PX = 16;
export const AUTO_SCROLL_REANCHOR_DISTANCE_PX = 24;

const getDistanceToBottom = (
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number => Math.max(0, scrollHeight - scrollTop - clientHeight);

export const getNextAutoScrollPinnedState = (
  input: AutoScrollPinnedStateInput,
): boolean => {
  const distanceToBottom = getDistanceToBottom(
    input.scrollHeight,
    input.currentScrollTop,
    input.clientHeight,
  );

  const isScrollingUp = input.currentScrollTop < input.previousScrollTop;
  const isScrollingDown = input.currentScrollTop > input.previousScrollTop;

  if (input.isPinned) {
    if (isScrollingUp && distanceToBottom > AUTO_SCROLL_RELEASE_DISTANCE_PX) {
      return false;
    }

    return true;
  }

  if (isScrollingDown && distanceToBottom <= AUTO_SCROLL_REANCHOR_DISTANCE_PX) {
    return true;
  }

  return false;
};
