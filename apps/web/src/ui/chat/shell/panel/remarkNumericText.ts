import type { PhrasingContent, Root, RootContent, Text } from "mdast";

// Keep signs, grouping, decimals, percentages and ranges in the same display run.
// Preserve Intl's direction marks and native digits; never add controls to the text.
const DIGITS = String.raw`\p{Nd}+(?:(?:[.,\u066b\u066c]|[ \u00a0\u202f](?=\p{Nd}{3}(?!\p{Nd})))\p{Nd}+)*`;
const AMOUNT = String.raw`[\u061c\u200e\u200f]*[+\-\u2212]?[\u061c\u200e\u200f]*\p{Sc}?[ \u00a0]?[+\-\u2212]?${DIGITS}(?:[ \u00a0]?[\p{Sc}%\u066a])?[\u061c\u200e\u200f]*`;
const RANGE_SEPARATOR = String.raw`[ \u00a0]*[\u2013\u2014-][ \u00a0]*`;
const NUMERIC_RUN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?![ \u00a0])${AMOUNT}(?:${RANGE_SEPARATOR}${AMOUNT})*(?![\p{L}\p{N}_])`,
  "gu",
);
const RANGE_AMOUNT = new RegExp(String.raw`(?:^|${RANGE_SEPARATOR})(${AMOUNT})`, "gu");
const ARABIC_MARK_BEFORE_SIGN = /^[\u061c\u200e\u200f]*\u061c[\u061c\u200f]*[+\-\u2212]/;

const isolate = (
  children: PhrasingContent[],
  hProperties: { dir: "ltr"; "data-preserve-number-order"?: "" },
): PhrasingContent => ({ type: "emphasis", data: { hName: "bdi", hProperties }, children });

const isolateNumericRun = (value: string): PhrasingContent => {
  const children: PhrasingContent[] = [];
  let offset = 0;
  for (const match of value.matchAll(RANGE_AMOUNT)) {
    const amount = match[1];
    if (!ARABIC_MARK_BEFORE_SIGN.test(amount)) continue;

    const start = match.index + match[0].length - amount.length;
    const isolated = isolate([{ type: "text", value: amount }], {
      dir: "ltr",
      "data-preserve-number-order": "",
    });
    if (amount === value) return isolated;
    if (start > offset) children.push({ type: "text", value: value.slice(offset, start) });
    children.push(isolated);
    offset = start + amount.length;
  }
  if (offset < value.length) children.push({ type: "text", value: value.slice(offset) });
  return isolate(children, { dir: "ltr" });
};

const isolateNumbers = (node: Text): PhrasingContent[] => {
  const result: PhrasingContent[] = [];
  let offset = 0;
  for (const match of node.value.matchAll(NUMERIC_RUN)) {
    if (match.index > offset) {
      result.push({ type: "text", value: node.value.slice(offset, match.index) });
    }
    result.push(isolateNumericRun(match[0]));
    offset = match.index + match[0].length;
  }
  if (offset < node.value.length) {
    result.push({ type: "text", value: node.value.slice(offset) });
  }
  return result;
};

const withNumericText = (nodes: ReadonlyArray<RootContent>): RootContent[] =>
  nodes.flatMap((node): RootContent[] => {
    if (node.type === "text") return isolateNumbers(node);
    if (!("children" in node)) return [node];
    return [{ ...node, children: withNumericText(node.children) } as RootContent];
  });

// Chat amounts arrive as Markdown prose and table cells rather than typed values.
export const remarkNumericText = (): ((tree: Root) => Root) => (tree) => ({
  ...tree,
  children: withNumericText(tree.children),
});
