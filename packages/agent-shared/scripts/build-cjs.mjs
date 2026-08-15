import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const entryNames = ["index", "discovery", "sql-policy", "crockford"];

await build({
  entryPoints: Object.fromEntries(
    entryNames.map((entryName) => [entryName, `src/${entryName}.ts`]),
  ),
  bundle: true,
  format: "cjs",
  outdir: "dist-cjs",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  sourcemap: true,
  target: "node24",
});

await mkdir("dist-cjs", { recursive: true });
for (const entryName of entryNames) {
  const declaration = await readFile(`dist/${entryName}.d.ts`, "utf8");
  await writeFile(
    `dist-cjs/${entryName}.d.cts`,
    declaration
      .replaceAll(".js\"", ".cjs\"")
      .replace(/\n\/\/# sourceMappingURL=.*$/u, ""),
    "utf8",
  );
}
