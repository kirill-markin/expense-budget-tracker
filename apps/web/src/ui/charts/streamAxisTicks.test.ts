import assert from "node:assert/strict";
import { test } from "node:test";

import { streamAxisTicks } from "./streamAxisTicks";

const monthLabels = (width: number, fontSize: number, count: number = 12): ReadonlyArray<Readonly<{ x: number; width: number }>> =>
  Array.from({ length: count }, (_, index) => ({
    x: 48 + (width - 72) * index / (count - 1),
    width: 7 * fontSize * 0.62,
  }));

test("desktop keeps upstream's centered monthly ticks", () => {
  const labels = monthLabels(900, 11);
  const ticks = streamAxisTicks(labels, 828, 900);
  assert.deepEqual(ticks, labels.map((_, index) => ({ index, anchor: "middle" })));
});

test("phone and tablet ticks use a regular month interval and leave label gaps", () => {
  for (const width of [288, 318, 716, 788, 1032]) {
    const labels = monthLabels(width, 12);
    const ticks = streamAxisTicks(labels, width - 72, width);
    const regular = ticks.slice(0, -1);
    const step = regular.length > 1 ? regular[1].index - regular[0].index : 1;
    for (let i = 1; i < regular.length; i += 1) {
      assert.equal(regular[i].index - regular[i - 1].index, step);
    }
    for (let i = 1; i < ticks.length; i += 1) {
      const previous = labels[ticks[i - 1].index];
      const current = labels[ticks[i].index];
      const start = current.x - current.width * (ticks[i].anchor === "end" ? 1 : 0.5);
      assert.ok(start - previous.x - previous.width / 2 >= 12);
    }
    const lastTick = ticks[ticks.length - 1];
    assert.equal(lastTick.index, labels.length - 1);
    const last = labels[lastTick.index];
    assert.ok(last.x + (lastTick.anchor === "end" ? 0 : last.width / 2) <= width);
  }
});

test("inward end anchoring removes an adjacent tick that would collide", () => {
  const labels = [{ x: 40, width: 50 }, { x: 120, width: 50 }, { x: 180, width: 50 }];
  assert.deepEqual(streamAxisTicks(labels, 170, 190), [
    { index: 0, anchor: "middle" },
    { index: 2, anchor: "end" },
  ]);
});

test("short February spacing cannot make intermediate labels collide", () => {
  for (const count of [12, 13, 24, 36]) {
    const dates = Array.from({ length: count }, (_, index) => Date.UTC(2025, index, 1));
    for (let width = 240; width <= 1500; width += 3) {
      const labels = dates.map((date) => ({
        x: 48 + (width - 72) * (date - dates[0]) / (dates[count - 1] - dates[0]),
        width: 7 * 12 * 0.62,
      }));
      const ticks = streamAxisTicks(labels, width - 72, width);
      for (let i = 1; i < ticks.length; i += 1) {
        const previous = labels[ticks[i - 1].index];
        const current = labels[ticks[i].index];
        const start = current.x - current.width * (ticks[i].anchor === "end" ? 1 : 0.5);
        assert.ok(start - previous.x - previous.width / 2 >= 12);
      }
    }
  }
});

test("empty and single-month charts have no duplicate ticks", () => {
  assert.deepEqual(streamAxisTicks([], 300, 350), []);
  assert.deepEqual(streamAxisTicks([{ x: 175, width: 50 }], 300, 350), [{ index: 0, anchor: "middle" }]);
});

test("compact ticks count back from the last month so the final interval matches the rest", () => {
  for (const width of [288, 318, 716]) {
    const labels = monthLabels(width, 12, 13);
    const ticks = streamAxisTicks(labels, width - 72, width);
    assert.ok(ticks.length > 2);
    const intervals = ticks.slice(1).map((tick, i) => tick.index - ticks[i].index);
    assert.ok(intervals.every((interval) => interval === intervals[0]), `uneven intervals at ${width}: ${intervals.join(",")}`);
  }
});
