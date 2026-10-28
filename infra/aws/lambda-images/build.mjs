import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const entries = {
  fx: "apps/worker/src/lambda.ts",
  authorizer: "apps/sql-api/src/authorizer.ts",
  api: "apps/sql-api/src/handler.ts",
  mcp: "apps/sql-api/src/mcp-handler.ts",
  sandbox: "apps/sandbox/src/handler.ts",
  signup: "infra/aws/lambda/pre-signup/index.mjs",
  email: "infra/aws/lambda/custom-email-sender/index.ts",
};
const functionName = process.argv[2];
if (!Object.hasOwn(entries, functionName)) {
  throw new Error(`Unknown Lambda image function ${functionName}; choose ${Object.keys(entries).join(", ")}`);
}
const sandbox = functionName === "sandbox";
await mkdir("/output", { recursive: true });
const entry = sandbox
  ? {
    stdin: {
      contents: `export { handler } from './${entries.sandbox}'; export { runSandboxSmoke } from './infra/aws/lambda-images/sandbox-smoke.ts';`,
      resolveDir: process.cwd(),
      sourcefile: "lambda-image-entry.ts",
      loader: "ts",
    },
  }
  : { entryPoints: [entries[functionName]] };
await build({
  ...entry,
  outfile: "/output/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: !sandbox,
  sourcemap: true,
  external: sandbox ? ["just-bash"] : [],
  banner: {
    js: "import './runtime.mjs'; import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);",
  },
});
if (sandbox) {
  const bundle = await readFile("/output/index.mjs", "utf8");
  if (!bundle.includes("pdfjsWorker ??= await Promise.resolve") || !bundle.includes("__nodeCreateRequire(import.meta.url)")) {
    throw new Error("Sandbox image bundle must inline the static pdf.js worker and preserve its CommonJS require banner");
  }
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const manifest = JSON.parse(await readFile("apps/sandbox/package.json", "utf8"));
  await writeFile("/output/package.json", JSON.stringify({
    dependencies: { "just-bash": manifest.dependencies["just-bash"] },
    overrides: root.overrides,
  }));
  await copyFile("package-lock.json", "/output/package-lock.json");
  await writeFile("/output/.npmrc", "omit=optional\nignore-scripts=true\n");
  execFileSync("npm", ["ci"], { cwd: "/output", stdio: "inherit" });
}
// Download in the build stage; every connection in the runtime uses this CA file.
execFileSync("curl", [
  "--fail", "--show-error", "--silent", "--location", "--retry", "3", "--retry-all-errors",
  "--connect-timeout", "10", "--max-time", "60", "--output", "/output/rds-global-bundle.pem",
  "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
], { stdio: "inherit" });
const pem = await readFile("/output/rds-global-bundle.pem", "utf8");
const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;
const certificates = pem.match(pattern);
if (certificates === null || pem.replace(pattern, "").trim() !== "") {
  throw new Error("RDS CA download must contain only PEM certificates");
}
for (const certificate of certificates) new X509Certificate(certificate);
for (const file of ["runtime.mjs", "probe.mjs"]) {
  await copyFile(`infra/aws/lambda-images/${file}`, `/output/${file}`);
}
