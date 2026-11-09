import assert from "node:assert/strict";
import { test } from "node:test";

import { chartSize } from "./useChartSize";

test("fine-pointer desktop keeps its viewBox even when chat narrows the chart", () => {
  for (const contentWidth of [804, 900, 1064, 1424]) {
    for (const desktopHeight of [520, 600]) {
      assert.deepEqual(chartSize(contentWidth, desktopHeight, false, false), {
        width: 900, height: desktopHeight, renderedWidth: contentWidth,
      });
    }
  }
});

test("coarse-pointer charts use their narrow container even in a desktop-width viewport", () => {
  assert.deepEqual(chartSize(804, 520, false, true), { width: 804, height: 465, renderedWidth: 804 });
  assert.deepEqual(chartSize(804, 600, false, true), { width: 804, height: 536, renderedWidth: 804 });
  assert.deepEqual(chartSize(600, 520, false, true), { width: 600, height: 450, renderedWidth: 600 });
});

test("coarse-pointer charts retain the desktop viewBox when the container is wide enough", () => {
  for (const contentWidth of [900, 1164, 1424]) {
    assert.deepEqual(chartSize(contentWidth, 520, false, true), {
      width: 900, height: 520, renderedWidth: contentWidth,
    });
  }
});

test("narrow viewports keep existing phone and tablet sizes for either pointer", () => {
  for (const coarsePointer of [false, true]) {
    assert.deepEqual(chartSize(328, 520, true, coarsePointer), { width: 328, height: 260, renderedWidth: 328 });
    assert.deepEqual(chartSize(358, 520, true, coarsePointer), { width: 358, height: 269, renderedWidth: 358 });
    assert.deepEqual(chartSize(788, 520, true, coarsePointer), { width: 788, height: 455, renderedWidth: 788 });
    assert.deepEqual(chartSize(1032, 520, true, coarsePointer), { width: 1032, height: 596, renderedWidth: 1032 });
  }
});

test("compact sizing rounds only the viewBox, preserving the measured CSS width", () => {
  assert.deepEqual(chartSize(803.75, 520, false, true), { width: 804, height: 465, renderedWidth: 803.75 });
});
