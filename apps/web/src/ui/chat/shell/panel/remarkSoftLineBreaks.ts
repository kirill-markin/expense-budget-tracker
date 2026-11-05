import type { PhrasingContent, Root, RootContent, Text } from "mdast";

const LINE_BREAK_PATTERN = /\r?\n|\r/;

const splitTextOnLineBreaks = (node: Text): PhrasingContent[] =>
  node.value.split(LINE_BREAK_PATTERN).flatMap((line, index): PhrasingContent[] => {
    const text: PhrasingContent[] = line === "" ? [] : [{ type: "text", value: line }];
    return index === 0 ? text : [{ type: "break" }, ...text];
  });

const withLineBreaks = (nodes: ReadonlyArray<RootContent>): RootContent[] =>
  nodes.flatMap((node): RootContent[] => {
    if (node.type === "text") {
      return splitTextOnLineBreaks(node);
    }
    if (!("children" in node)) {
      return [node];
    }
    // Text only sits among phrasing siblings and a break is phrasing content,
    // so the rewritten children stay valid for every parent type.
    return [{ ...node, children: withLineBreaks(node.children) } as RootContent];
  });

// Soft line breaks render as <br>, so line-structured answers keep their lines in
// paragraphs and tight list items alike. Preserving them with CSS white-space would
// also keep the formatting newlines mdast-util-to-hast inserts between blocks.
export const remarkSoftLineBreaks = (): ((tree: Root) => Root) => (tree) => ({
  ...tree,
  children: withLineBreaks(tree.children),
});
