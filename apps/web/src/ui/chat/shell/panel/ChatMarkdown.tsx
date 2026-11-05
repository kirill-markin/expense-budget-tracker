import type { PhrasingContent, Root, RootContent, Text } from "mdast";
import type { ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "./ChatMarkdown.module.css";

type Props = Readonly<{
  text: string;
}>;

const EXTERNAL_LINK_PATTERN = /^(https?|mailto):/i;

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
const remarkSoftLineBreaks = (): ((tree: Root) => Root) => (tree) => ({
  ...tree,
  children: withLineBreaks(tree.children),
});

const REMARK_PLUGINS = [remarkGfm, remarkSoftLineBreaks];

const COMPONENTS: Components = {
  // Only absolute external links stay clickable: relative and fragment hrefs would
  // navigate inside the app, and react-markdown already blanks unsafe schemes.
  a: ({ href, children }) => {
    if (href === undefined || !EXTERNAL_LINK_PATTERN.test(href)) {
      return <>{children}</>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  ),
};

export const ChatMarkdown = (props: Props): ReactElement => (
  <div className={styles.markdown}>
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {props.text}
    </ReactMarkdown>
  </div>
);
