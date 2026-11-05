import type { ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "./ChatMarkdown.module.css";
import { remarkSoftLineBreaks } from "./remarkSoftLineBreaks";

type Props = Readonly<{
  text: string;
}>;

const EXTERNAL_LINK_PATTERN = /^(https?|mailto):/i;

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
