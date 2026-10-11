import assert from "node:assert/strict";
import test from "node:test";

import { ChatFilesObjectStore } from "@/server/chatFiles/objectStore";

// Every environment input the assertions below read, pinned. The credential
// chain is still consulted; its first link, fromEnv, wins only while
// AWS_PROFILE is unset, because a profile makes the chain skip fromEnv, and a
// profile resolving to session credentials adds X-Amz-Security-Token to the
// query string. The two checksum variables are pinned to the SDK defaults, so
// what keeps this green is the client option under test and not a developer's
// shell. No request is made: the URLs are only parsed.
process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;
process.env.AWS_REQUEST_CHECKSUM_CALCULATION = "when_supported";
process.env.AWS_RESPONSE_CHECKSUM_VALIDATION = "when_supported";

const OBJECT_KEY = "sessions/session-1/4f0a1d2e-7c3b-4a9d-8e51-6b2c9d0f3a74";

const createObjectStore = (): ChatFilesObjectStore =>
  new ChatFilesObjectStore({
    bucket: "chat-files-test-bucket",
    region: "eu-central-1",
    endpoint: null,
    forcePathStyle: false,
  });

/** The seven SigV4 query-string parameters, in sorted order. */
const EXPECTED_SIGV4_QUERY_PARAMETERS: ReadonlyArray<string> = [
  "X-Amz-Algorithm",
  "X-Amz-Content-Sha256",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-Signature",
  "X-Amz-SignedHeaders",
];

/** The seven SigV4 query-string parameters, plus the SDK's operation marker. */
const EXPECTED_PUT_QUERY_PARAMETERS: ReadonlyArray<string> = [
  ...EXPECTED_SIGV4_QUERY_PARAMETERS,
  "x-id",
];

const sortedQueryParameterNames = (url: string): ReadonlyArray<string> =>
  [...new URL(url).searchParams.keys()].sort();

/**
 * requestChecksumCalculation: "WHEN_REQUIRED" is what keeps this green. The
 * SDK default computes a checksum for every PutObject, which for a pre-signed
 * URL means a CRC32 of the absent body signed into the query string; S3 then
 * ignores it, so an SDK upgrade reintroducing it would pass unnoticed in
 * production.
 */
test("pre-signed upload URLs sign only the headers the app binds", async (): Promise<void> => {
  const objectStore = createObjectStore();

  const putUrl = await objectStore.presignPutUrl(OBJECT_KEY, "text/csv", 11, 900);
  assert.equal(
    new URL(putUrl).searchParams.get("X-Amz-SignedHeaders"),
    "content-length;content-type;host",
  );
  assert.deepEqual(sortedQueryParameterNames(putUrl), EXPECTED_PUT_QUERY_PARAMETERS);

  const workFileUrl = await objectStore.presignWorkFileUploadUrl(OBJECT_KEY, "text/csv", 900);
  assert.equal(
    new URL(workFileUrl).searchParams.get("X-Amz-SignedHeaders"),
    "content-type;host",
  );
  assert.deepEqual(sortedQueryParameterNames(workFileUrl), EXPECTED_PUT_QUERY_PARAMETERS);
});

/**
 * The deliberate asymmetry: x-amz-checksum-mode stays, because it comes from
 * responseChecksumValidation, a separate option the PUT fix left alone. It asks
 * S3 to return the stored checksum on download and costs the GET nothing.
 */
test("pre-signed download URLs keep the response checksum mode", async (): Promise<void> => {
  const objectStore = createObjectStore();

  const getUrl = await objectStore.presignGetUrl(OBJECT_KEY, "report.csv", 900);
  assert.deepEqual(sortedQueryParameterNames(getUrl), [
    ...EXPECTED_SIGV4_QUERY_PARAMETERS,
    "response-content-disposition",
    "x-amz-checksum-mode",
    "x-id",
  ]);
});
