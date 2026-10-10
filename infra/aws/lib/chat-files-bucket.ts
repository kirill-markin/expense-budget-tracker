import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

// Objects live under this prefix only, so the web task role can be scoped to
// it. The app builds every key through buildChatFileObjectKey in
// apps/web/src/server/chatFiles/objectStore.ts, which repeats this prefix.
export const CHAT_FILES_OBJECT_PREFIX = "sessions/";

export interface ChatFilesBucketProps {
  appDomain: string;
}

export interface ChatFilesBucketResult {
  chatFilesBucket: s3.Bucket;
}

export function chatFilesBucket(
  scope: Construct,
  props: ChatFilesBucketProps,
): ChatFilesBucketResult {
  const bucket = new s3.Bucket(scope, "ChatFiles", {
    bucketName: `expense-tracker-chat-files-${cdk.Aws.ACCOUNT_ID}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    // Objects live exactly as long as their chat session, which this product
    // retains indefinitely, so there is no object expiration rule: a row in
    // chat_files always resolves to an object. The only lifecycle rule reclaims
    // parts left behind by interrupted multipart uploads.
    lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
    // Browser uploads and downloads go straight to S3 with pre-signed URLs,
    // so only the app origin may call the bucket cross-origin.
    cors: [{
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      allowedOrigins: [`https://${props.appDomain}`],
      allowedHeaders: ["content-type", "x-amz-checksum-sha256"],
      exposedHeaders: ["ETag"],
      maxAge: 300,
    }],
  });

  return { chatFilesBucket: bucket };
}
