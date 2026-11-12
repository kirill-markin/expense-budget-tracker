import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCellOverlayPosition } from "./cellOverlayPosition";

test("a partially scrolled cell opens a complete editor inside a phone viewport", () => {
  const position = resolveCellOverlayPosition(
    { top: 700, left: -100, width: 500, height: 40 },
    { top: 0, left: 0, width: 360, height: 740 },
    200, 260, 680, false,
  );
  assert.deepEqual(position, { top: 472, left: 8, width: 344, maxHeight: 260 });
});

test("RTL editors align to the inline-start edge of their cell", () => {
  const position = resolveCellOverlayPosition(
    { top: 100, left: 200, width: 100, height: 40 },
    { top: 0, left: 0, width: 390, height: 844 },
    200, 260, 680, true,
  );
  assert.equal(position.left, 100);
  assert.equal(position.width, 200);
});

test("the software keyboard bounds overlays to the remaining visual viewport", () => {
  const position = resolveCellOverlayPosition(
    { top: 600, left: 0, width: 112, height: 40 },
    { top: 200, left: 0, width: 360, height: 180 },
    300, 260, 680, false,
  );
  assert.deepEqual(position, { top: 208, left: 8, width: 300, maxHeight: 164 });
});
