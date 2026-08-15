import { readFileSync } from "node:fs";

/** @typedef {null | boolean | number | string | ReadonlyArray<JsonValue> | JsonObject} JsonValue */
/** @typedef {Readonly<Record<string, JsonValue | undefined>>} JsonObject */
/** @typedef {{ readonly file: string, readonly fields: ReadonlyArray<string> }} JsonSurfaceSpec */
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
const SERVER_VERSION_PATTERN = /^const SERVER_VERSION = "([^"\r\n]+)";$/gm;
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
 * @param {string} path
 * @returns {VersionSurface}
 */
const readRuntimeVersionSurface = (path) => {
  const matches = [...readFileSync(path, "utf8").matchAll(SERVER_VERSION_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(
      `${path} must contain exactly one literal matching 'const SERVER_VERSION = "<version>";', found ${matches.length}`,
    );
  }

  const value = matches[0]?.[1];
  if (value === undefined || value === "") {
    throw new Error(`${path} SERVER_VERSION must be a non-empty string`);
  }
  return { path: `${path}#SERVER_VERSION`, value };
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
  readRuntimeVersionSurface(MCP_SERVER_PATH),
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
