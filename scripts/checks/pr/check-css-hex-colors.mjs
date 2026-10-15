import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";

/** @typedef {{ readonly file: string, readonly declaration: string, readonly count: number }} LiteralExemption */
/** @typedef {{ readonly file: string, readonly line: number, readonly hex: string, readonly declaration: string }} HexOccurrence */

const SCAN_ROOT = "apps/web/src";
const TOKENS_FILE = `${SCAN_ROOT}/app/styles/tokens.css`;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//gu;
/** Bounded so a longer token such as `#1234567` never matches one of its shorter prefixes. */
const HEX_COLOR_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/giu;

/**
 * Hex colors that predate this check. Each entry matches by file and by the exact
 * whitespace-collapsed declaration, and `count` pins how many times it may appear, so a
 * newly written hex never inherits an exemption.
 * Shrink this list by moving the value into tokens.css; never grow it.
 * @type {ReadonlyArray<LiteralExemption>}
 */
const KNOWN_LITERAL_EXEMPTIONS = [
  { file: `${SCAN_ROOT}/ui/charts/BudgetStreamChart.module.css`, declaration: "color: #f5c451;", count: 1 },
  { file: `${SCAN_ROOT}/ui/chat/shell/panel/ChatPanel.module.css`, declaration: "border: 2px dashed var(--accent, #4a90d9);", count: 1 },
  { file: `${SCAN_ROOT}/ui/chat/shell/panel/ChatPanel.module.css`, declaration: "color: #fff;", count: 1 },
  { file: `${SCAN_ROOT}/ui/tables/budget/BudgetTable.module.css`, declaration: "border-bottom: 7px solid #4caf50;", count: 1 },
  { file: `${SCAN_ROOT}/ui/tables/budget/BudgetTable.module.css`, declaration: "border-top: 7px solid #f44336;", count: 1 },
  { file: `${SCAN_ROOT}/ui/tables/budget/BudgetTable.module.css`, declaration: "border-bottom: 7px solid #f44336;", count: 1 },
  { file: `${SCAN_ROOT}/ui/tables/budget/BudgetTable.module.css`, declaration: "border-top: 7px solid #4caf50;", count: 1 },
];

/**
 * @param {string} root
 * @returns {ReadonlyArray<string>}
 */
const collectCssFiles = (root) => (
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => `${root}/${entry.split(sep).join("/")}`)
    .sort()
);

/**
 * @param {string} line
 * @returns {string}
 */
const normalizeDeclaration = (line) => line.trim().replace(/\s+/gu, " ");

/**
 * The same source with every comment span replaced by spaces, so a hex documented in a comment is
 * never a violation. Newlines survive, so reported line numbers stay those of the original file.
 * @param {string} source
 * @returns {string}
 */
const blankComments = (source) => (
  source.replace(COMMENT_PATTERN, (comment) => comment.replace(/[^\n]/gu, " "))
);

/**
 * @param {string} file
 * @returns {ReadonlyArray<HexOccurrence>}
 */
const scanCssFile = (file) => (
  blankComments(readFileSync(file, "utf8"))
    .split("\n")
    .flatMap((text, index) => [...text.matchAll(HEX_COLOR_PATTERN)].map((match) => ({
      file,
      line: index + 1,
      hex: match[0],
      declaration: normalizeDeclaration(text),
    })))
);

/**
 * @param {{ readonly file: string, readonly declaration: string }} entry
 * @returns {string}
 */
const formatExemptionKey = (entry) => `${entry.file}|${entry.declaration}`;

const cssFiles = collectCssFiles(SCAN_ROOT);
if (cssFiles.length === 0) {
  throw new Error(`CSS hex color check found no *.css files under ${SCAN_ROOT}`);
}
if (!cssFiles.includes(TOKENS_FILE)) {
  throw new Error(
    `CSS hex color check expects the token definitions at ${TOKENS_FILE}. Update TOKENS_FILE in this script if they moved.`,
  );
}

const exemptionsByKey = new Map(
  KNOWN_LITERAL_EXEMPTIONS.map((exemption) => [formatExemptionKey(exemption), exemption]),
);
if (exemptionsByKey.size !== KNOWN_LITERAL_EXEMPTIONS.length) {
  throw new Error(
    "CSS hex color check found duplicate KNOWN_LITERAL_EXEMPTIONS entries for the same file and declaration. Merge them into one entry carrying the combined count.",
  );
}

const occurrences = cssFiles
  .filter((file) => file !== TOKENS_FILE)
  .flatMap(scanCssFile);
const exemptedKeys = occurrences
  .map(formatExemptionKey)
  .filter((key) => exemptionsByKey.has(key));
const observedCounts = exemptedKeys.reduce(
  (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1),
  /** @type {Map<string, number>} */ (new Map()),
);
const violations = occurrences.filter((occurrence) => !exemptionsByKey.has(formatExemptionKey(occurrence)));
const countMismatches = KNOWN_LITERAL_EXEMPTIONS
  .map((exemption) => ({ exemption, observed: observedCounts.get(formatExemptionKey(exemption)) ?? 0 }))
  .filter(({ exemption, observed }) => observed !== exemption.count);

const violationFailures = violations.length === 0
  ? []
  : [
    "These hex colors must become theme tokens:",
    ...violations.map(
      (occurrence) => `- ${occurrence.file}:${occurrence.line}: ${occurrence.hex} in ${JSON.stringify(occurrence.declaration)}`,
    ),
    `Outside ${TOKENS_FILE} a color must be referenced as var(--token), never written as a hex.`,
    `KNOWN_LITERAL_EXEMPTIONS in this script also baselines ${KNOWN_LITERAL_EXEMPTIONS.length} older declarations at a fixed count. That list only shrinks, so do not add an entry for new code.`,
  ];
const mismatchFailures = countMismatches.length === 0
  ? []
  : [
    "These KNOWN_LITERAL_EXEMPTIONS entries no longer match the CSS:",
    ...countMismatches.map(
      ({ exemption, observed }) => `- ${exemption.file}: ${JSON.stringify(exemption.declaration)}: expected ${exemption.count}, found ${observed}`,
    ),
    "A grown count means a new hex reused a baselined declaration: make that one a theme token. A dropped count means the entry is stale: lower its count or delete it from this script.",
  ];
const failures = [...violationFailures, ...mismatchFailures];

if (failures.length > 0) {
  throw new Error(
    `CSS hex color check failed. Define themeable colors in ${TOKENS_FILE} under both :root and :root[data-theme="dark"], then reference them with var(--token).\n${failures.join("\n")}`,
  );
}

process.stdout.write(
  `CSS hex color check passed: ${cssFiles.length} files scanned, ${exemptedKeys.length} known exemptions\n`,
);
