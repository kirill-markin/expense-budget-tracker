import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PDFJS_ASSET_DIRECTORIES = [
  "cmaps",
  "wasm",
  "standard_fonts",
  "iccs",
];

const readJsonFile = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON file at ${filePath}`, { cause: error });
  }
};

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDirectory, "..");
const webPackagePath = join(webRoot, "package.json");
const pdfjsPackagePath = require.resolve("pdfjs-dist/package.json");
const pdfjsRoot = dirname(pdfjsPackagePath);
const destinationRoot = join(webRoot, "public", "pdfjs-assets");

const webPackage = await readJsonFile(webPackagePath);
const pdfjsPackage = await readJsonFile(pdfjsPackagePath);
const expectedPdfjsVersion = webPackage.dependencies?.["pdfjs-dist"];
if (typeof expectedPdfjsVersion !== "string") {
  throw new Error(
    `Missing pinned pdfjs-dist dependency in ${webPackagePath}`,
  );
}
if (expectedPdfjsVersion !== pdfjsPackage.version) {
  throw new Error(
    `Installed pdfjs-dist version ${String(pdfjsPackage.version)} does not match pinned web dependency ${expectedPdfjsVersion}`,
  );
}

const assetSources = await Promise.all(
  PDFJS_ASSET_DIRECTORIES.map(async (directoryName) => {
    const sourcePath = join(pdfjsRoot, directoryName);
    let sourceStats;
    try {
      sourceStats = await stat(sourcePath);
    } catch (error) {
      throw new Error(
        `Required pdfjs-dist asset directory is missing: ${sourcePath}`,
        { cause: error },
      );
    }
    if (!sourceStats.isDirectory()) {
      throw new Error(
        `Required pdfjs-dist asset path is not a directory: ${sourcePath}`,
      );
    }
    return { directoryName, sourcePath };
  }),
);

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });
for (const { directoryName, sourcePath } of assetSources) {
  await cp(sourcePath, join(destinationRoot, directoryName), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

process.stdout.write(
  `${JSON.stringify({
    event: "pdfjs_assets_copied",
    version: pdfjsPackage.version,
    directories: PDFJS_ASSET_DIRECTORIES,
    destination: destinationRoot,
  })}\n`,
);
