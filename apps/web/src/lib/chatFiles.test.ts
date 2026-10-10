import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatFileSandboxPath,
  CHAT_FILE_OPAQUE_MEDIA_TYPE,
  getAcceptedChatFileMediaTypes,
  getChatFileNameFromSandboxPath,
  isAcceptedChatFileMediaType,
  parseChatFileMediaType,
  sanitizeChatFileName,
  UnusableChatFileNameError,
} from "@/lib/chatFiles";

test("media type parsing normalizes a bare type and rejects anything else", (): void => {
  assert.equal(parseChatFileMediaType(" Text/CSV "), "text/csv");
  assert.equal(parseChatFileMediaType("text/csv; charset=utf-8"), null);
  assert.equal(parseChatFileMediaType("text"), null);
  assert.equal(parseChatFileMediaType(""), null);
});

test("a listed extension accepts its own types and the opaque type only", (): void => {
  assert.equal(isAcceptedChatFileMediaType("report.csv", "text/csv"), true);
  assert.equal(isAcceptedChatFileMediaType("report.csv", "text/plain"), true);
  assert.equal(isAcceptedChatFileMediaType("report.csv", CHAT_FILE_OPAQUE_MEDIA_TYPE), true);
  assert.equal(isAcceptedChatFileMediaType("report.csv", "image/png"), false);
  assert.equal(isAcceptedChatFileMediaType("archive.zip", "application/zip"), true);
  // The accepted type reads the extension the stored path keeps, not the raw one.
  assert.equal(isAcceptedChatFileMediaType("report.csv ", "text/csv"), true);
});

test("an unlisted extension is accepted as an opaque binary only", (): void => {
  assert.equal(isAcceptedChatFileMediaType("disk.dmg", CHAT_FILE_OPAQUE_MEDIA_TYPE), true);
  assert.equal(isAcceptedChatFileMediaType("disk.dmg", "application/x-apple-diskimage"), false);
  // Stored as /files/env, so it carries no extension to accept a type for.
  assert.equal(isAcceptedChatFileMediaType(".env", CHAT_FILE_OPAQUE_MEDIA_TYPE), true);
  assert.equal(isAcceptedChatFileMediaType(".env", "text/plain"), false);
});

test("sanitization keeps letters of any script and drops traversal and shell characters", (): void => {
  assert.equal(sanitizeChatFileName("../../etc/pa$$wd.txt"), "pa_wd.txt");
  assert.equal(sanitizeChatFileName("C:\\reports\\Q3 report.CSV"), "Q3_report.csv");
  assert.equal(sanitizeChatFileName("отчёт за май.pdf"), "отчёт_за_май.pdf");
  assert.equal(sanitizeChatFileName("-rf"), "rf");
  assert.equal(sanitizeChatFileName(".env"), "env");
});

test("sanitization refuses a name that keeps no usable character", (): void => {
  assert.throws(
    () => sanitizeChatFileName("///"),
    UnusableChatFileNameError,
  );
  assert.throws(
    () => getAcceptedChatFileMediaTypes("///"),
    UnusableChatFileNameError,
  );
});

test("the sandbox path suffixes a repeated name before the extension", (): void => {
  assert.equal(buildChatFileSandboxPath("report.csv", 1), "/files/report.csv");
  assert.equal(buildChatFileSandboxPath("report.csv", 3), "/files/report-3.csv");
  assert.equal(buildChatFileSandboxPath("notes", 2), "/files/notes-2");
  assert.throws(() => buildChatFileSandboxPath("report.csv", 0), Error);
});

test("the download name is the sandbox path file name", (): void => {
  assert.equal(getChatFileNameFromSandboxPath("/files/report-2.csv"), "report-2.csv");
  assert.throws(() => getChatFileNameFromSandboxPath("/files/"), Error);
});
