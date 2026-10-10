import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The ECS task role is granted object actions on this prefix only (the same
// value lives in infra/aws/lib/chat-files-bucket.ts), so every key the app
// mints must come from buildChatFileObjectKey.
const CHAT_FILES_OBJECT_PREFIX = "sessions/";

export const buildChatFileObjectKey = (sessionId: string, fileId: string): string =>
  `${CHAT_FILES_OBJECT_PREFIX}${sessionId}/${fileId}`;

const requireChatFileObjectKey = (objectKey: string): string => {
  if (!objectKey.startsWith(CHAT_FILES_OBJECT_PREFIX)) {
    throw new Error(
      `Chat file object key must come from buildChatFileObjectKey and start with "${CHAT_FILES_OBJECT_PREFIX}", got "${objectKey}"`,
    );
  }

  return objectKey;
};

// Protocol ceiling only: SigV4 caps a query-string pre-sign at seven days.
// Callers pass short expiries, because a URL cannot outlive the credentials
// that signed it.
const MAX_PRESIGN_EXPIRES_IN_SECONDS = 604800;

const requirePresignExpiry = (expiresInSeconds: number): number => {
  if (
    !Number.isInteger(expiresInSeconds)
    || expiresInSeconds < 1
    || expiresInSeconds > MAX_PRESIGN_EXPIRES_IN_SECONDS
  ) {
    throw new Error(
      `Pre-signed URL expiry must be a whole number of seconds between 1 and ${MAX_PRESIGN_EXPIRES_IN_SECONDS}, got ${expiresInSeconds}`,
    );
  }

  return expiresInSeconds;
};

// encodeURIComponent leaves "'", "(", ")", "!" and "*" raw, and the first four
// are not RFC 8187 attr-char, so they are percent-encoded here. RFC 6266 also
// asks for an ASCII filename beside filename* for parsers that ignore the
// extended form.
const buildAttachmentDisposition = (downloadFileName: string): string => {
  if (downloadFileName === "") {
    throw new Error("Pre-signed download file name must not be empty");
  }

  const asciiFileName = downloadFileName.replace(/[^\x20-\x7E]|["\\]/g, "_");
  const extendedFileName = encodeURIComponent(downloadFileName).replace(
    /['()!*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${extendedFileName}`;
};

export type ChatFilesObjectStoreConfig = Readonly<{
  bucket: string;
  region: string;
  // Set only for S3-compatible services in self-hosted deployments; null means AWS S3.
  endpoint: string | null;
  forcePathStyle: boolean;
}>;

const requireEnvValue = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} environment variable is not set`);
  }

  return value;
};

const readOptionalEnvValue = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
};

const readBooleanEnvValue = (name: string): boolean => {
  const value = readOptionalEnvValue(name);
  if (value === null) {
    return false;
  }

  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be "true" or "false", got "${value}"`);
  }

  return value === "true";
};

export const readChatFilesObjectStoreConfig = (): ChatFilesObjectStoreConfig => ({
  bucket: requireEnvValue("CHAT_FILES_BUCKET"),
  region: requireEnvValue("CHAT_FILES_S3_REGION"),
  endpoint: readOptionalEnvValue("CHAT_FILES_S3_ENDPOINT"),
  forcePathStyle: readBooleanEnvValue("CHAT_FILES_S3_FORCE_PATH_STYLE"),
});

/**
 * The only place the app talks to object storage.
 *
 * Takes an endpoint and a path-style switch from configuration so the same code
 * serves AWS S3 and the S3-compatible service a self-hosted deployment runs.
 */
export class ChatFilesObjectStore {
  private readonly bucket: string;

  private readonly client: S3Client;

  constructor(config: ChatFilesObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
    });
  }

  async presignGetUrl(
    objectKey: string,
    downloadFileName: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: requireChatFileObjectKey(objectKey),
        // Stored content types come from the uploader, so the response must
        // force a download: otherwise an object saved as text/html or
        // image/svg+xml executes as a document on the bucket's own origin.
        ResponseContentDisposition: buildAttachmentDisposition(downloadFileName),
      }),
      { expiresIn: requirePresignExpiry(expiresInSeconds) },
    );
  }

  async presignPutUrl(
    objectKey: string,
    mediaType: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: requireChatFileObjectKey(objectKey),
        ContentType: mediaType,
      }),
      { expiresIn: requirePresignExpiry(expiresInSeconds) },
    );
  }

  async readObjectBytes(objectKey: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: requireChatFileObjectKey(objectKey) }),
    );
    if (response.Body === undefined) {
      throw new Error(`Object read returned no body, bucket=${this.bucket}, key=${objectKey}`);
    }

    return response.Body.transformToByteArray();
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: requireChatFileObjectKey(objectKey) }),
    );
  }
}

let objectStore: ChatFilesObjectStore | null = null;

export const getChatFilesObjectStore = (): ChatFilesObjectStore => {
  if (objectStore !== null) {
    return objectStore;
  }

  objectStore = new ChatFilesObjectStore(readChatFilesObjectStoreConfig());
  return objectStore;
};
