import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type OpenApiDocument = Readonly<Record<string, unknown>>;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

const findOpenApiPath = (): string => {
  const candidates = [
    path.resolve(process.cwd(), "api/openapi.yaml"),
    path.resolve(process.cwd(), "../../api/openapi.yaml"),
    path.resolve(currentDirPath, "../../../api/openapi.yaml"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not locate api/openapi.yaml");
};

let cachedDocument: OpenApiDocument | null = null;

export const loadOpenApiDocument = (): OpenApiDocument => {
  if (cachedDocument !== null) {
    return cachedDocument;
  }

  cachedDocument = JSON.parse(fs.readFileSync(findOpenApiPath(), "utf8")) as OpenApiDocument;
  return cachedDocument;
};
