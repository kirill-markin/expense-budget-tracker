import type { PhrasingContent, Root, RootContent, Text } from "mdast";

// Keep signs, grouping, decimals, percentages and ranges in the same display run.
// Preserve Intl's direction marks and native digits; never add controls to the text.
const DIGITS = String.raw`\p{Nd}+(?:(?:[.,\u066b\u066c]|[ \u00a0\u202f](?=\p{Nd}{3}(?!\p{Nd})))\p{Nd}+)*`;
const AMOUNT = String.raw`[\u061c\u200e\u200f]*[+\-\u2212]?[\u061c\u200e\u200f]*\p{Sc}?[ \u00a0]?[+\-\u2212]?${DIGITS}(?:[ \u00a0]?[\p{Sc}%\u066a])?[\u061c\u200e\u200f]*`;
const NUMERIC_RUN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${AMOUNT}(?:[ \u00a0]*[\u2013\u2014-][ \u00a0]*${AMOUNT})*(?![\p{L}\p{N}_])`,
  "gu",
);

const isolateNumbers = (node: Text): PhrasingContent[] => {
  const result: PhrasingContent[] = [];
  let offset = 0;
  for (const match of node.value.matchAll(NUMERIC_RUN)) {
    if (match.index > offset) {
      result.push({ type: "text", value: node.value.slice(offset, match.index) });
    }
    result.push({
      type: "emphasis",
      data: { hName: "bdi", hProperties: { dir: "ltr" } },
      children: [{ type: "text", value: match[0] }],
    });
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
