import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * Fixed function name.
 *
 * The web task needs the name in its container environment and an invoke
 * permission on this exact function, and compute() runs before this construct,
 * so both sides reference the name instead of the construct.
 */
export const CHAT_SANDBOX_FUNCTION_NAME = "expense-tracker-chat-sandbox";

/**
 * Each execution environment reserves 10 GB, so concurrency is what bounds the
 * cost of this function. One chat runs its commands one at a time, so this is a
 * ceiling on simultaneously computing chats rather than on commands.
 */
export const CHAT_SANDBOX_RESERVED_CONCURRENCY = 5;

export interface ChatSandboxProps {
  chatFilesBucket: s3.Bucket;
}

export interface ChatSandboxResult {
  chatSandboxFn: lambda_nodejs.NodejsFunction;
}

/**
 * Lambda that runs chat `bash` commands over one session's files.
 *
 * The security boundary is this function, not the shell it embeds: the
 * execution role carries nothing but the basic log permissions the construct
 * adds, there is no VPC, and the only objects it can reach are the ones the web
 * task pre-signed for a single invocation. It opens no database connection, so
 * it has no pool and no pool-error metric.
 */
export function chatSandbox(scope: Construct, props: ChatSandboxProps): ChatSandboxResult {
  const chatSandboxFn = new lambda_nodejs.NodejsFunction(scope, "ChatSandboxHandler", {
    functionName: CHAT_SANDBOX_FUNCTION_NAME,
    entry: path.join(__dirname, "../../../apps/sandbox/src/handler.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    // Matches the ECS tasks, and the shell's own dependencies are platform
    // independent, so one architecture serves every surface.
    architecture: lambda.Architecture.ARM_64,
    // A 50 MB CSV aggregation needs a multi-gigabyte heap, and Lambda scales
    // vCPU with memory, so the largest size is also the fastest per command.
    memorySize: 10240,
    timeout: cdk.Duration.minutes(2),
    reservedConcurrentExecutions: CHAT_SANDBOX_RESERVED_CONCURRENCY,
    environment: {
      // Per-isolate V8 ceiling, inherited by the session child process that
      // actually runs the command; the supervisor only moves JSON. It is well
      // below the function's 10,240 MB because the python worker's own isolate,
      // the emscripten wasm heap and the file buffers all live outside V8's old
      // space and share the same memory with it.
      NODE_OPTIONS: "--max-old-space-size=6144",
      // The sandbox refuses a pre-signed URL on any other host. It has no VPC
      // and therefore unrestricted egress, so this list is what stops a
      // malformed or hostile payload from making it an HTTPS client for an
      // arbitrary host.
      CHAT_SANDBOX_OBJECT_HOSTS: props.chatFilesBucket.bucketRegionalDomainName,
    },
    bundling: {
      // just-bash resolves its Python and SQLite workers through
      // `import.meta.url`, which its CommonJS entry point cannot answer: under
      // CJS both commands fail to load. The handler is therefore emitted as an
      // ES module so the package's ESM entry point is the one that gets loaded.
      format: lambda_nodejs.OutputFormat.ESM,
      // Installed rather than bundled: the workers above are separate files
      // resolved at runtime, and the 9.9 MB vendored CPython tree has to keep
      // its exact relative paths.
      nodeModules: ["just-bash"],
      commandHooks: {
        beforeBundling: () => [],
        // npm reads this file from the install directory. The two optional
        // native dependencies only add zstd and xz support, which nothing here
        // uses, and they would otherwise be built from source inside the
        // bundling step.
        beforeInstall: (_inputDir: string, outputDir: string) => [
          `echo 'omit=optional' > ${path.join(outputDir, ".npmrc")}`,
        ],
        afterBundling: () => [],
      },
    },
  });

  return { chatSandboxFn };
}
