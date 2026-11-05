import assert from "node:assert/strict";
import test from "node:test";

import type { PhrasingContent, Root } from "mdast";

import { remarkSoftLineBreaks } from "./remarkSoftLineBreaks";

const transform = remarkSoftLineBreaks();

const paragraphRoot = (children: PhrasingContent[]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

const A_BREAK_B: PhrasingContent[] = [
  { type: "text", value: "a" },
  { type: "break" },
  { type: "text", value: "b" },
];

test("a soft line break in paragraph text becomes a break node", (): void => {
  assert.deepEqual(
    transform(paragraphRoot([{ type: "text", value: "a\nb" }])),
    paragraphRoot(A_BREAK_B),
  );
});

test("CRLF and lone CR line endings become a single break node", (): void => {
  for (const value of ["a\r\nb", "a\rb"]) {
    assert.deepEqual(
      transform(paragraphRoot([{ type: "text", value }])),
      paragraphRoot(A_BREAK_B),
    );
  }
});

test("a soft line break in a tight list item paragraph becomes a break node", (): void => {
  const listRoot = (children: PhrasingContent[]): Root => ({
    type: "root",
    children: [
      {
        type: "list",
        ordered: false,
        spread: false,
        children: [
          { type: "listItem", spread: false, children: [{ type: "paragraph", children }] },
        ],
      },
    ],
  });

  assert.deepEqual(
    transform(listRoot([{ type: "text", value: "a\nb" }])),
    listRoot(A_BREAK_B),
  );
});

test("a soft line break inside strong becomes a break node within strong", (): void => {
  assert.deepEqual(
    transform(paragraphRoot([{ type: "strong", children: [{ type: "text", value: "a\nb" }] }])),
    paragraphRoot([{ type: "strong", children: A_BREAK_B }]),
  );
});

test("an existing hard break stays a single break node", (): void => {
  assert.deepEqual(transform(paragraphRoot(A_BREAK_B)), paragraphRoot(A_BREAK_B));
});

test("inline code and code blocks keep their newlines", (): void => {
  const codeRoot = (): Root => ({
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "inlineCode", value: "a\nb" }] },
      { type: "code", lang: null, meta: null, value: "a\nb" },
    ],
  });

  assert.deepEqual(transform(codeRoot()), codeRoot());
});

test("the input tree is not mutated", (): void => {
  const input = paragraphRoot([{ type: "strong", children: [{ type: "text", value: "a\nb" }] }]);
  const snapshot = structuredClone(input);

  transform(input);

  assert.deepEqual(input, snapshot);
});
