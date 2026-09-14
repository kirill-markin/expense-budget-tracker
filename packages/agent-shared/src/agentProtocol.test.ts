import assert from "node:assert/strict";
import test from "node:test";
import { WRITING_DATA_GUIDE } from "./agentProtocol.js";

// Guards the composition itself: the single literal this guide replaced could not lose a section.
const WRITING_DATA_SECTION_HEADINGS: ReadonlyArray<string> = [
  "## Writing data",
  "### Discovery before writing",
  "### Entry shapes",
  "### Source rows and dates",
  "### Checklist for every entry",
  "### Questions",
  "### Approval and execution",
  "### Progress and resuming",
  "### Final verification",
];

test("the shared write guide composes every section exactly once and in order", (): void => {
  assert.deepEqual(
    WRITING_DATA_GUIDE.split("\n").filter((line) => line.startsWith("#")),
    WRITING_DATA_SECTION_HEADINGS,
  );
});
