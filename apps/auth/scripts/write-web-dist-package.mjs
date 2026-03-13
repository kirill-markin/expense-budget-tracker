import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.resolve(scriptDir, "../dist/web");

await mkdir(targetDir, { recursive: true });
await writeFile(
  path.join(targetDir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  "utf8",
);
