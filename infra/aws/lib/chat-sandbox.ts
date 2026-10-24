import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

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

const buildSandboxDependencyInstallCommand = (inputDir: string, outputDir: string): string => {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { execFileSync } = require("node:child_process");',
    'const [inputDir, outputDir] = process.argv.slice(1);',
    'const root = JSON.parse(fs.readFileSync(path.join(inputDir, "package.json"), "utf8"));',
    'const sandbox = JSON.parse(fs.readFileSync(path.join(inputDir, "apps/sandbox/package.json"), "utf8"));',
    'fs.writeFileSync(path.join(outputDir, "package.json"), JSON.stringify({ dependencies: { "just-bash": sandbox.dependencies["just-bash"] }, overrides: root.overrides }));',
    'fs.copyFileSync(path.join(inputDir, "package-lock.json"), path.join(outputDir, "package-lock.json"));',
    'fs.writeFileSync(path.join(outputDir, ".npmrc"), "omit=optional\\nignore-scripts=true\\n");',
    'execFileSync("npm", ["ci"], { cwd: outputDir, stdio: "inherit" });',
  ].join(" ");
  const args = [script, inputDir, outputDir].map((value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`,
  );
  return `node -e ${args.join(" ")}`;
};

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
      externalModules: ["just-bash"],
      // The document parsers are CommonJS and reach for node builtins with
      // `require`, which esbuild cannot turn into an import while emitting an ES
      // module: it emits a `__require` shim that throws
      // `Dynamic require of "url" is not supported` instead, and it picks the
      // real `require` over the shim when one is in scope. Without this line
      // every DOCX fails at runtime in the bundle while passing unbundled under
      // `tsx`, which is the same shape as the pdf.js worker below and was found
      // the same way: by converting one of each format inside a real bundle.
      // The alias is what the guard greps for, and it is capitalised so that
      // `createRequire(import.meta.url)` inside a bundled dependency cannot
      // stand in for it.
      banner: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);",
      commandHooks: {
        // CDK's nodeModules staging discards root overrides. Install explicitly
        // so npm ci keeps the security pins; omit unused native codecs and run
        // no dependency scripts in the Lambda staging directory.
        beforeBundling: (inputDir: string, outputDir: string) => [
          buildSandboxDependencyInstallCommand(inputDir, outputDir),
        ],
        beforeInstall: () => [],
        // Two things the emitted bundle has to carry that no test of this
        // repository can check, because both are differences between the bundle
        // and the unbundled layout every suite runs in: the source passes under
        // `tsx` either way, so the bundle is what gets asserted, and a failure
        // here fails the deploy instead of production.
        //
        // pdf.js reaches for its worker through a runtime `await import`, which
        // no bundler can follow, so prepareOperation.ts imports the worker by a
        // static specifier and parks it on `globalThis.pdfjsWorker`. Dropping
        // that one line takes this bundle from 7,481,080 to 4,859,753 bytes and
        // makes every PDF fail with "Setting up fake worker failed". Its token
        // is our own line as esbuild re-emits it, not a pdf.js symbol, and it
        // asserts both halves of what that protects: the assignment is there,
        // and `await Promise.resolve().then(...)` is what esbuild writes when it
        // has inlined the imported module rather than left a dynamic import for
        // the runtime to resolve. The banner's token is the capitalised alias
        // above, for the reason recorded there. Measured: each appears exactly
        // once with its line and not at all without it, neither depends on
        // anything but this repository and esbuild, and a pdfjs-dist upgrade
        // that moves the worker file fails here rather than in production.
        // Neither would survive `minify: true`, which this construct does not
        // set.
        //
        // Braced because CDK joins every hook's steps with `&&` into one
        // `bash -c`: an ungrouped `|| { ...; exit 1; }` would report this
        // message for a failure in any earlier step of the same command.
        afterBundling: (_inputDir: string, outputDir: string) => [
          `{ grep -q 'pdfjsWorker ??= await Promise.resolve' ${path.join(outputDir, "index.mjs")} || { echo 'chat sandbox bundle carries no pdf.js worker: restore the static import of pdfjs-dist/legacy/build/pdf.worker.mjs and the globalThis.pdfjsWorker assignment in apps/sandbox/src/prepareOperation.ts, or every PDF fails at runtime with "Setting up fake worker failed"' >&2; exit 1; }; }`,
          `{ grep -q '__nodeCreateRequire(import.meta.url)' ${path.join(outputDir, "index.mjs")} || { echo 'chat sandbox bundle has no CommonJS require: restore the createRequire banner in infra/aws/lib/chat-sandbox.ts, or every DOCX fails at runtime with a dynamic-require error for a node builtin' >&2; exit 1; }; }`,
        ],
      },
    },
  });

  return { chatSandboxFn };
}
