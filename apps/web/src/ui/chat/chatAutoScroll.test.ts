import assert from "node:assert/strict";
import test from "node:test";

import { getNextAutoScrollPinnedState } from "./chatAutoScroll";

test("stays pinned while the user remains near the bottom", () => {
  assert.equal(getNextAutoScrollPinnedState({
    isPinned: true,
    previousScrollTop: 776,
    currentScrollTop: 776,
    scrollHeight: 1600,
    clientHeight: 800,
  }), true);
});

test("unpins after a small upward scroll beyond the release threshold", () => {
  assert.equal(getNextAutoScrollPinnedState({
    isPinned: true,
    previousScrollTop: 800,
    currentScrollTop: 780,
    scrollHeight: 1600,
    clientHeight: 800,
  }), false);
});

test("does not re-pin just because assistant content grows", () => {
  assert.equal(getNextAutoScrollPinnedState({
    isPinned: false,
    previousScrollTop: 600,
    currentScrollTop: 600,
    scrollHeight: 1600,
    clientHeight: 800,
  }), false);
});

test("re-pins when the user returns near the bottom", () => {
  assert.equal(getNextAutoScrollPinnedState({
    isPinned: false,
    previousScrollTop: 760,
    currentScrollTop: 776,
    scrollHeight: 1600,
    clientHeight: 800,
  }), true);
});

test("does not unpin on downward scrolling", () => {
  assert.equal(getNextAutoScrollPinnedState({
    isPinned: true,
    previousScrollTop: 760,
    currentScrollTop: 770,
    scrollHeight: 1600,
    clientHeight: 800,
  }), true);
});
