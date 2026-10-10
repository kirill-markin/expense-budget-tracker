import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  readZipUncompressedByteLength,
  selectContainerPartsForSizingForTest,
} from "@/server/chat/openai/responses/input";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import type { ContentPart, FileContentPart } from "@/server/chat/types";

const WORKBOOK_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A minimal STORED ZIP with the given entries, so archives of any shape - and
 * dishonest ones - can be built without a writer that only emits workbooks.
 */
const buildZipArchive = (
  entries: ReadonlyArray<readonly [string, Buffer]>,
): Uint8Array => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + nameBytes.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    content.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Uint8Array.from(Buffer.concat([...locals, directory, end]));
};

const buildWorkbook = (rows: number): FileContentPart => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["date", "amount", "category", "currency"],
      ...Array.from({ length: rows }, (_, index) => [
        "2026-08-16",
        -(1_000 + index),
        "Groceries",
        "EUR",
      ]),
    ]),
    "Ledger",
  );

  return {
    type: "file",
    fileName: `ledger-${String(rows)}.xlsx`,
    mediaType: WORKBOOK_MEDIA_TYPE,
    base64Data: XLSX.write(workbook, { type: "base64", bookType: "xlsx" }),
  };
};

const buildCompressedWorkbook = (rows: number): Uint8Array => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(
      Array.from({ length: rows }, (_, index) => ["2026-08-16", -(1_000 + index)]),
    ),
    "Ledger",
  );

  return Uint8Array.from(Buffer.from(
    XLSX.write(workbook, { type: "base64", bookType: "xlsx", compression: true }),
    "base64",
  ));
};

const toBytes = (part: FileContentPart): Uint8Array =>
  Uint8Array.from(Buffer.from(part.base64Data, "base64"));

const toPart = (
  bytes: Uint8Array,
  fileName: string,
  mediaType: string = WORKBOOK_MEDIA_TYPE,
): FileContentPart => ({
  type: "file",
  fileName,
  mediaType,
  base64Data: Buffer.from(bytes).toString("base64"),
});

/** Offset of the end-of-central-directory record, scanning from the tail. */
const findEndOfCentralDirectory = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("fixture has no end-of-central-directory record");
};

const firstCentralDirectoryEntryOffset = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return view.getUint32(findEndOfCentralDirectory(bytes) + 16, true);
};

/**
 * Central-directory offset of the largest deflated entry, which is the one worth
 * lying about - the first entry of a workbook is a few hundred bytes of
 * `[Content_Types].xml`.
 */
const largestDeflatedEntryOffset = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOfDirectory = findEndOfCentralDirectory(bytes);
  let entryOffset = endOfDirectory - view.getUint32(endOfDirectory + 12, true);
  let largest = { offset: -1, size: 0 };
  while (entryOffset < endOfDirectory) {
    const size = view.getUint32(entryOffset + 24, true);
    if (view.getUint16(entryOffset + 10, true) !== 0 && size > largest.size) {
      largest = { offset: entryOffset, size };
    }
    entryOffset += 46
      + view.getUint16(entryOffset + 28, true)
      + view.getUint16(entryOffset + 30, true)
      + view.getUint16(entryOffset + 32, true);
  }
  if (largest.offset === -1) {
    throw new Error("fixture has no deflated entry");
  }

  return largest.offset;
};

/** Offset of the first local file header of a `buildZipArchive` output. */
const FIRST_LOCAL_HEADER_OFFSET = 0;

/**
 * Rewrites the size fields of the first entry, which is how the measured attacks
 * understated a stored sheet.
 */
const writeZipEntrySizes = (
  bytes: Uint8Array,
  sizes: Readonly<{
    centralUncompressed?: number;
    centralCompressed?: number;
    localUncompressed?: number;
    localCompressed?: number;
  }>,
): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const entryOffset = firstCentralDirectoryEntryOffset(copy);
  if (sizes.centralCompressed !== undefined) {
    view.setUint32(entryOffset + 20, sizes.centralCompressed, true);
  }
  if (sizes.centralUncompressed !== undefined) {
    view.setUint32(entryOffset + 24, sizes.centralUncompressed, true);
  }
  if (sizes.localCompressed !== undefined) {
    view.setUint32(FIRST_LOCAL_HEADER_OFFSET + 18, sizes.localCompressed, true);
  }
  if (sizes.localUncompressed !== undefined) {
    view.setUint32(FIRST_LOCAL_HEADER_OFFSET + 22, sizes.localUncompressed, true);
  }

  return copy;
};

/** Rewrites one 16-bit field of the end-of-central-directory record. */
const writeZipEndRecordUint16 = (
  bytes: Uint8Array,
  fieldOffset: number,
  value: number,
): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  new DataView(copy.buffer).setUint16(
    findEndOfCentralDirectory(copy) + fieldOffset,
    value,
    true,
  );

  return copy;
};

/** Rewrites one 32-bit little-endian field, to build a dishonest archive. */
const writeUint32 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  new DataView(copy.buffer).setUint32(offset, value, true);

  return copy;
};

const userMessage = (content: ReadonlyArray<ContentPart>): ServerChatMessage =>
  ({ role: "user", content });

const assistantMessage = (): ServerChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Answer" }],
  openaiItems: [],
});

test("readZipUncompressedByteLength reads what a workbook will inflate to", (): void => {
  const small = buildWorkbook(50);
  const large = buildWorkbook(2_000);

  const smallBytes = readZipUncompressedByteLength(toBytes(small));
  const largeBytes = readZipUncompressedByteLength(toBytes(large));

  assert.ok(smallBytes !== null && largeBytes !== null);
  // The sheet XML dominates, so the declared total tracks the row count rather
  // than the stored size, which is the whole point of reading the directory.
  assert.ok(smallBytes > 10_000);
  assert.ok(largeBytes > smallBytes * 5);
});

test("readZipUncompressedByteLength refuses what it cannot read", (): void => {
  const workbook = toBytes(buildWorkbook(50));

  // Not a ZIP at all: a legacy `.xls`, a text file, or anything else.
  assert.equal(readZipUncompressedByteLength(Uint8Array.from([1, 2, 3, 4, 5])), null);
  assert.equal(
    readZipUncompressedByteLength(Uint8Array.from(Buffer.from("date,amount\n"))),
    null,
  );
  // A ZIP whose central directory is gone: refused rather than guessed at from
  // the stored length, which says nothing about the contents.
  assert.equal(readZipUncompressedByteLength(workbook.slice(0, 64)), null);
  const damaged = Uint8Array.from(workbook);
  damaged.fill(0, damaged.length - 22);
  assert.equal(readZipUncompressedByteLength(damaged), null);
});

test("many small workbooks are all sized, and a large one is left to its cap", (): void => {
  const small = Array.from({ length: 8 }, () => buildWorkbook(2));
  const history: ReadonlyArray<ServerChatMessage> = small.flatMap((part) => [
    userMessage([part]),
    assistantMessage(),
  ]);

  const selected = selectContainerPartsForSizingForTest(history, []);

  // A count cap of four left the other four charged the extracted-text cap,
  // which over-sized a 40-message session by 180k tokens and dropped messages.
  assert.equal(selected.length, small.length);

  // A workbook past the per-container limit is excluded, and excluding it does
  // not cost the small ones their place.
  const historyWithLarge: ReadonlyArray<ServerChatMessage> = [
    userMessage([buildWorkbook(20_000)]),
    assistantMessage(),
    ...history,
  ];
  const selectedWithLarge = selectContainerPartsForSizingForTest(historyWithLarge, []);
  assert.equal(selectedWithLarge.length, small.length);
  assert.equal(
    selectedWithLarge.some((part) => part.fileName === "ledger-20000.xlsx"),
    false,
  );
});

test("a container whose declared size cannot be read is not extracted", (): void => {
  // A damaged or ZIP64 directory leaves only the stored length, which for a ZIP
  // says nothing: a 300 KB ZIP64 `.xlsx` can hold 70 MB of sheet XML, so
  // comparing the stored length against the per-container limit would admit it
  // and block the event loop for seconds. Such a container is left to its cap.
  const intact = buildWorkbook(50);
  const intactBytes = toBytes(intact);
  // The record that defines the archive is intact, but its directory does not
  // point at entries - so the declared sizes cannot be read and the file must be
  // left to its cap rather than judged by its stored length.
  const damaged = toPart(
    writeUint32(intactBytes, firstCentralDirectoryEntryOffset(intactBytes), 0),
    "damaged.xlsx",
  );
  assert.ok(intactBytes.length < 1_048_576);

  const selected = selectContainerPartsForSizingForTest(
    [userMessage([damaged]), assistantMessage(), userMessage([intact]), assistantMessage()],
    [],
  );

  assert.deepEqual(selected, [intact]);
});

test("a deflated entry's declared size is the larger of its two headers", (): void => {
  // SheetJS reads local file headers; the central directory is what a tidy
  // reader uses. A crafted pair can disagree, so the honest size is the larger
  // of the two - asserted against independently rewritten archives rather than
  // against another output of the same function.
  const bytes = buildCompressedWorkbook(2_000);
  const honest = readZipUncompressedByteLength(bytes);
  assert.ok(honest !== null && honest > 20_000);

  const entryOffset = largestDeflatedEntryOffset(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstEntryHonestSize = view.getUint32(entryOffset + 24, true);
  const localOffset = view.getUint32(entryOffset + 42, true);
  assert.ok(firstEntryHonestSize > 1_000);

  // The central directory claims the entry is empty; the local header tells the
  // truth, and the truth is what has to be charged.
  const centralLies = readZipUncompressedByteLength(
    writeUint32(bytes, entryOffset + 24, 0),
  );
  assert.ok(
    centralLies !== null && centralLies >= firstEntryHonestSize,
    `A zeroed central-directory size produced ${String(centralLies)} rather than at `
    + `least the ${String(firstEntryHonestSize)} bytes its local header declares`,
  );

  // And the other direction: a local header claiming 70 MB must not be ignored
  // because the central directory looks modest.
  const localLies = readZipUncompressedByteLength(
    writeUint32(bytes, localOffset + 22, 70_000_000),
  );
  assert.ok(
    localLies !== null && localLies >= 70_000_000,
    `A 70 MB local-header size produced ${String(localLies)}`,
  );
  const centralLiesHigh = readZipUncompressedByteLength(
    writeUint32(bytes, entryOffset + 24, 70_000_000),
  );
  assert.ok(centralLiesHigh !== null && centralLiesHigh >= 70_000_000);
});

test("media is excluded from both container formats, and nothing else is", (): void => {
  // Neither reader turns media into text: `XLSX.read` never makes CSV out of
  // `xl/media`, and `mammoth` reads word parts. Everything else is counted,
  // including the parts a reader resolves indirectly - `mammoth` finds a DOCX's
  // main part through `_rels/.rels`, so scoping to `word/document.xml` sized a
  // `word/document2.xml` at zero and left footnotes and comments uncounted.
  const photo = Buffer.from("x".repeat(600_000));
  const text = Buffer.from("<w:document><w:t>Budget notes</w:t></w:document>");
  const withMedia = buildZipArchive([
    ["word/document2.xml", text],
    ["word/footnotes.xml", text],
    ["word/media/image1.png", photo],
    ["word/media/image2.png", photo],
  ]);
  const withoutMedia = buildZipArchive([
    ["word/document2.xml", text],
    ["word/footnotes.xml", text],
  ]);

  const sizedWithMedia = readZipUncompressedByteLength(withMedia);
  const sizedWithoutMedia = readZipUncompressedByteLength(withoutMedia);

  assert.ok(sizedWithMedia !== null && sizedWithoutMedia !== null);
  // The 1.2 MB of photos cost nothing, so this document is sized and admitted
  // where counting its media would have refused it.
  assert.equal(sizedWithMedia, sizedWithoutMedia);
  assert.ok(sizedWithMedia < 1_024);
  const docx = toPart(withMedia, "report.docx", DOCX_MEDIA_TYPE);
  assert.deepEqual(
    selectContainerPartsForSizingForTest([userMessage([docx]), assistantMessage()], []),
    [docx],
  );

  // And a word part that is not the main document still counts, so a large one
  // is refused rather than sized at zero.
  const bigFootnotes = buildZipArchive([
    ["word/document2.xml", text],
    ["word/footnotes.xml", Buffer.from("x".repeat(1_200_000))],
  ]);
  const sizedBigFootnotes = readZipUncompressedByteLength(bigFootnotes);
  assert.ok(sizedBigFootnotes !== null && sizedBigFootnotes > 1_048_576);
  assert.deepEqual(
    selectContainerPartsForSizingForTest(
      [userMessage([toPart(bigFootnotes, "notes.docx", DOCX_MEDIA_TYPE)]), assistantMessage()],
      [],
    ),
    [],
  );
});

test("an archive with bytes prepended to it is read, not waved through", (): void => {
  // A ZIP is defined by its end record, not by a leading signature, and readers
  // open prefixed archives happily. Judged by a `PK` check at offset zero, this
  // file took the "not a ZIP, use the stored length" branch: 165,923 bytes
  // admitted while holding 48,600,151 bytes of `document.xml`.
  const honest = buildZipArchive([
    ["word/document.xml", Buffer.from("x".repeat(1_200_000))],
  ]);
  const honestSize = readZipUncompressedByteLength(honest);

  for (const prefixLength of [1, 2, 3, 512, 70_000]) {
    const prefixed = Uint8Array.from(
      Buffer.concat([Buffer.alloc(prefixLength, 0x50), Buffer.from(honest)]),
    );

    const sized = readZipUncompressedByteLength(prefixed);

    assert.equal(
      sized,
      honestSize,
      `A ${String(prefixLength)} byte prefix changed the declared size to ${String(sized)}`,
    );
    // And the file is refused, rather than admitted on its compressed length.
    assert.deepEqual(
      selectContainerPartsForSizingForTest(
        [
          userMessage([toPart(prefixed, "report.docx", DOCX_MEDIA_TYPE)]),
          assistantMessage(),
        ],
        [],
      ),
      [],
    );
  }

  // The same for a workbook, whose extension and media type are equally
  // client-controlled.
  const prefixedWorkbook = Uint8Array.from(
    Buffer.concat([Buffer.from("PK"), Buffer.from(toBytes(buildWorkbook(2_000)))]),
  );
  const prefixedWorkbookSize = readZipUncompressedByteLength(prefixedWorkbook);
  assert.ok(prefixedWorkbookSize !== null && prefixedWorkbookSize > 300_000);
});

test("a stored entry is sized by the data it holds, not by what it declares", (): void => {
  // For a STORED entry a reader takes the data as it lies, and every size field
  // is client-controlled. Declaring 100 bytes for a 1.2 MB stored sheet sized the
  // file at a few kilobytes, let it through the gate, and bought 646 ms of
  // synchronous work per turn for every later turn of that session.
  const storedBytes = Buffer.from("x".repeat(1_200_000));
  const archive = buildZipArchive([["xl/worksheets/sheet1.xml", storedBytes]]);
  const honestSize = readZipUncompressedByteLength(archive);
  assert.ok(honestSize !== null && honestSize >= storedBytes.length);

  // All four size fields rewritten, which keeps the entry self-consistent: only
  // the space its data occupies gives it away.
  const lying = writeZipEntrySizes(archive, {
    centralUncompressed: 100,
    localUncompressed: 100,
    centralCompressed: 100,
    localCompressed: 100,
  });

  const sized = readZipUncompressedByteLength(lying);

  assert.ok(
    sized !== null && sized >= storedBytes.length,
    `A stored entry declaring 100 bytes everywhere was sized ${String(sized)}`,
  );
  assert.deepEqual(
    selectContainerPartsForSizingForTest(
      [userMessage([toPart(lying, "ledger.xlsx")]), assistantMessage()],
      [],
    ),
    [],
  );
});

test("a stored entry whose two sizes disagree is refused", (): void => {
  // A stored entry's compressed and uncompressed sizes are the same number by
  // definition, so a pair that disagrees is malformed and is not sized at all.
  const archive = buildZipArchive([
    ["xl/worksheets/sheet1.xml", Buffer.from("x".repeat(1_200_000))],
  ]);

  for (const sizes of [
    { centralUncompressed: 100 },
    { localUncompressed: 100 },
    { centralCompressed: 100, localCompressed: 100 },
  ]) {
    assert.equal(
      readZipUncompressedByteLength(writeZipEntrySizes(archive, sizes)),
      null,
      `A stored entry with ${JSON.stringify(sizes)} was sized rather than refused`,
    );
  }
});

test("a fake end record cannot aim the directory at a file's own data", (): void => {
  // Every offset in the end record is attacker-steerable, so a 22 byte fake one
  // appended to an honest workbook - with `directorySize` chosen to land inside
  // a stored entry's data - had its "entries" verified against the attacker's
  // own bytes and sized 1,114.
  const archive = buildZipArchive([
    ["xl/worksheets/sheet1.xml", Buffer.from("x".repeat(1_200_000))],
  ]);
  const fakeEnd = Buffer.alloc(22);
  fakeEnd.writeUInt32LE(0x06054b50, 0);
  fakeEnd.writeUInt16LE(1, 8);
  fakeEnd.writeUInt16LE(1, 10);
  // A directory that would start somewhere inside the stored data.
  fakeEnd.writeUInt32LE(600_000, 12);
  fakeEnd.writeUInt32LE(0, 16);
  const withFakeEnd = Uint8Array.from(
    Buffer.concat([Buffer.from(archive), fakeEnd]),
  );

  assert.equal(readZipUncompressedByteLength(withFakeEnd), null);

  // An entry count of zero, and a count that disagrees with the directory.
  const zeroCount = writeZipEndRecordUint16(archive, 10, 0);
  assert.equal(readZipUncompressedByteLength(zeroCount), null);
  const wrongCount = writeZipEndRecordUint16(archive, 10, 7);
  assert.equal(readZipUncompressedByteLength(wrongCount), null);
});

/**
 * A directory of `entryCount` entries all pointing at one 30 byte local header -
 * legal enough to walk, and the shape that makes a per-entry scan quadratic.
 */
const buildSharedHeaderArchive = (entryCount: number): Uint8Array => {
  const name = Buffer.from("xl/worksheets/sheet1.xml", "utf8");
  const data = Buffer.from("x".repeat(64));
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const directory = Buffer.concat(Array.from({ length: entryCount }, () => central));

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length, 16);

  return Uint8Array.from(Buffer.concat([local, directory, end]));
};

/**
 * The largest directory a ZIP can declare, since the entry count is 16 bits and
 * has to match the entries actually walked.
 */
const MAXIMUM_ZIP_ENTRY_COUNT = 65_535;

/**
 * Generous against a measured 17.5 ms worst case for that directory, and still
 * more than ten times under the 2,282 ms a per-entry scan took - so this fails
 * loudly if the lookup goes quadratic again, without being flaky on a slower
 * machine. Fuzzing cannot reach this: random mutation never synthesises a large
 * directory, so the fixture has to be constructed.
 */
const MAXIMUM_SIZING_MILLISECONDS = 150;

test("sizing stays linear against the largest directory a ZIP can declare", (): void => {
  const archive = buildSharedHeaderArchive(MAXIMUM_ZIP_ENTRY_COUNT);

  const started = performance.now();
  const sized = readZipUncompressedByteLength(archive);
  const elapsed = performance.now() - started;

  assert.ok(sized !== null);
  assert.ok(
    elapsed < MAXIMUM_SIZING_MILLISECONDS,
    `Sizing ${String(MAXIMUM_ZIP_ENTRY_COUNT)} entries sharing one local header took `
    + `${elapsed.toFixed(0)} ms, past the ${String(MAXIMUM_SIZING_MILLISECONDS)} ms `
    + "this gate allows itself - the per-entry extent lookup is quadratic again",
  );
  // And the file is refused, so the work is not re-paid on every later turn.
  assert.deepEqual(
    selectContainerPartsForSizingForTest(
      [userMessage([toPart(archive, "ledger.xlsx")]), assistantMessage()],
      [],
    ),
    [],
  );
});

test("the extraction budget keeps the newest containers and the current turn's", (): void => {
  // Each of these inflates to roughly 325 KB, so a 2 MiB budget admits about six
  // and the newest are the ones that survive - they are the likeliest to replay.
  const parts = Array.from({ length: 10 }, () => buildWorkbook(2_000));
  const history: ReadonlyArray<ServerChatMessage> = parts.flatMap((part) => [
    userMessage([part]),
    assistantMessage(),
  ]);
  const turnAttachment = buildWorkbook(2);

  const selected = selectContainerPartsForSizingForTest(history, [turnAttachment]);

  assert.ok(selected.length > 1 && selected.length < parts.length);
  // The current turn's attachment is always sized: this request extracts it
  // regardless, so the only question is whether the window sees it first.
  assert.ok(selected.includes(turnAttachment));
  // What survives the budget is the newest stored containers, in history order.
  const storedSelected = selected.filter((part) => part !== turnAttachment);
  const storedIndexes = storedSelected.map((part) => parts.indexOf(part));
  assert.deepEqual([...storedIndexes].sort((a, b) => a - b), storedIndexes);
  assert.equal(storedIndexes.at(-1), parts.length - 1);
});
