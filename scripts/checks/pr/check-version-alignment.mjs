import { readFileSync } from "node:fs";

/** @typedef {null | boolean | number | string | ReadonlyArray<JsonValue> | JsonObject} JsonValue */
/** @typedef {Readonly<Record<string, JsonValue | undefined>>} JsonObject */
/** @typedef {{ readonly file: string, readonly fields: ReadonlyArray<string> }} JsonSurfaceSpec */
/** @typedef {{ readonly file: string, readonly label: string, readonly prefix: string, readonly suffix: string }} SourceSurfaceSpec */
/** @typedef {{ readonly path: string, readonly value: string }} VersionSurface */

const VERSIONED_PACKAGE_PATHS = [
  "apps/auth",
  "apps/sql-api",
  "apps/web",
  "apps/worker",
  "infra/aws",
  "packages/agent-shared",
];
const SHARED_DEPENDENCY_PACKAGE_PATHS = [
  "apps/auth",
  "apps/sql-api",
  "apps/web",
  "infra/aws",
];
const SHARED_DEPENDENCY_NAME = "@expense-budget-tracker/agent-shared";
const PACKAGE_LOCK_PATH = "package-lock.json";
const MCP_SERVER_PATH = "apps/sql-api/src/mcp/server.ts";
const MCP_SERVER_TEST_PATH = "apps/sql-api/src/mcp/server.test.ts";
const OPENAI_DOSSIER_PATH = "docs/openai-mcp-submission.md";
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** @type {ReadonlyArray<JsonSurfaceSpec>} */
const JSON_SURFACE_SPECS = [
  ...VERSIONED_PACKAGE_PATHS.flatMap((packagePath) => [
    { file: `${packagePath}/package.json`, fields: ["version"] },
    { file: PACKAGE_LOCK_PATH, fields: ["packages", packagePath, "version"] },
  ]),
  ...SHARED_DEPENDENCY_PACKAGE_PATHS.flatMap((packagePath) => [
    {
      file: `${packagePath}/package.json`,
      fields: ["dependencies", SHARED_DEPENDENCY_NAME],
    },
    {
      file: PACKAGE_LOCK_PATH,
      fields: ["packages", packagePath, "dependencies", SHARED_DEPENDENCY_NAME],
    },
  ]),
  { file: "server.json", fields: ["version"] },
];

/** @type {ReadonlyArray<SourceSurfaceSpec>} */
const OPERATIONAL_SOURCE_SURFACE_SPECS = [
  {
    file: MCP_SERVER_PATH,
    label: "SERVER_VERSION",
    prefix: "const SERVER_VERSION = \"",
    suffix: "\";",
  },
  {
    file: MCP_SERVER_TEST_PATH,
    label: "getServerVersion assertion",
    prefix: "        version: \"",
    suffix: "\",",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "Version under evaluation",
    prefix: "| Version under evaluation | ",
    suffix: " |",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "G01 Registry lookup version",
    prefix: "| G01 | Exact MCP Registry version, `GET` | `https://registry.modelcontextprotocol.io/v0.1/servers/com.expense-budget-tracker%2Fexpense-budget-tracker/versions/",
    suffix: "` |",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "G02 expected Registry record version",
    prefix: "| G02 | MCP Registry latest search, `GET` | `https://registry.modelcontextprotocol.io/v0.1/servers?search=com.expense-budget-tracker%2Fexpense-budget-tracker&version=latest` | Final `200`, `application/json`, no redirect. Before publication it must not contain this name/version; after publication it must contain the exact `",
    suffix: "` record",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "MCP server identity version",
    prefix: "| `version` | `",
    suffix: "` |",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "Evidence record runtime version",
    prefix: "| Runtime version | ",
    suffix: " unless a later aligned version is promoted |",
  },
  {
    file: OPENAI_DOSSIER_PATH,
    label: "Evidence record Registry manifest version",
    prefix: "| Registry manifest identity/version | `com.expense-budget-tracker/expense-budget-tracker` / `",
    suffix: "` |",
  },
];

/**
 * @param {JsonValue | undefined} value
 * @returns {value is JsonObject}
 */
const isJsonObject = (value) => (
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
);

/**
 * @param {JsonSurfaceSpec} spec
 * @returns {string}
 */
const formatJsonSurfacePath = (spec) => (
  `${spec.file}#${spec.fields.map((field) => `[${JSON.stringify(field)}]`).join("")}`
);

/**
 * @param {string} path
 * @returns {JsonObject}
 */
const readJsonObject = (path) => {
  const source = readFileSync(path, "utf8");
  /** @type {JsonValue} */
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new SyntaxError(`Failed to parse ${path}: ${error.message}`, { cause: error });
  }

  if (!isJsonObject(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return value;
};

/**
 * @param {JsonObject} document
 * @param {JsonSurfaceSpec} spec
 * @returns {VersionSurface}
 */
const readJsonVersionSurface = (document, spec) => {
  const path = formatJsonSurfacePath(spec);
  /** @type {JsonValue | undefined} */
  let value = document;

  for (const field of spec.fields) {
    if (!isJsonObject(value)) {
      throw new TypeError(`${path} must resolve through JSON objects`);
    }
    value = value[field];
  }

  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return { path, value };
};

/**
 * @param {SourceSurfaceSpec} spec
 * @returns {VersionSurface}
 */
const readOperationalSourceVersionSurface = (spec) => {
  const matchingLines = readFileSync(spec.file, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(spec.prefix));
  if (matchingLines.length !== 1) {
    throw new Error(
      `${spec.file} must contain exactly one ${spec.label} literal matching ${JSON.stringify(`${spec.prefix}<version>${spec.suffix}`)}, found ${matchingLines.length}`,
    );
  }

  const line = matchingLines[0];
  const suffixIndex = line?.indexOf(spec.suffix, spec.prefix.length) ?? -1;
  if (suffixIndex === -1) {
    throw new Error(
      `${spec.file} ${spec.label} literal must contain ${JSON.stringify(spec.suffix)} after the version`,
    );
  }
  const value = line?.slice(spec.prefix.length, suffixIndex);
  if (value === undefined || value === "") {
    throw new Error(`${spec.file} ${spec.label} must be a non-empty string`);
  }
  return { path: `${spec.file}#${spec.label}`, value };
};

const jsonDocuments = new Map(
  [...new Set(JSON_SURFACE_SPECS.map((spec) => spec.file))]
    .map((path) => [path, readJsonObject(path)]),
);
const jsonVersionSurfaces = JSON_SURFACE_SPECS.map((spec) => {
  const document = jsonDocuments.get(spec.file);
  if (document === undefined) {
    throw new Error(`Missing parsed JSON document for ${spec.file}`);
  }
  return readJsonVersionSurface(document, spec);
});
const versionSurfaces = [
  ...jsonVersionSurfaces,
  ...OPERATIONAL_SOURCE_SURFACE_SPECS.map(readOperationalSourceVersionSurface),
];

const invalidSurfaces = versionSurfaces.filter(
  (surface) => !SEMVER_PATTERN.test(surface.value),
);
const distinctVersions = new Set(versionSurfaces.map((surface) => surface.value));
const invalidFailures = invalidSurfaces.length === 0
  ? []
  : [
    "These version values are not valid SemVer:",
    ...invalidSurfaces.map((surface) => `- ${surface.path}: ${JSON.stringify(surface.value)}`),
  ];
const alignmentFailures = distinctVersions.size === 1
  ? []
  : [
    "Version values are not aligned:",
    ...versionSurfaces.map((surface) => `- ${surface.path}: ${JSON.stringify(surface.value)}`),
  ];
const failures = [...invalidFailures, ...alignmentFailures];

if (failures.length > 0) {
  throw new Error(
    `Version alignment check failed. Set every version surface to one identical valid SemVer value.\n${failures.join("\n")}`,
  );
}

const [version] = distinctVersions;
if (version === undefined) {
  throw new Error("Version alignment check did not inspect any version surfaces");
}
process.stdout.write(`Version alignment check passed: ${version}\n`);
