import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createSqlParserKernel,
  DEFAULT_SQL_PARSER_LIMITS,
  type SqlParserLimits,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";

const limits = (
  maxSourceCodeUnits: number,
  maxTokens: number,
  maxNestingDepth: number,
  maxWorkUnits: number,
): SqlParserLimits => ({
  maxNestingDepth,
  maxSourceCodeUnits,
  maxTokens,
  maxWorkUnits,
});

const expectParserError = (
  action: () => void,
  code: SqlPolicyParserErrorCode,
  range: Readonly<{ start: number; end: number }>,
): SqlPolicyParserError => {
  let caught: Error | null = null;
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      caught = error;
    }
  }
  assert.ok(caught instanceof SqlPolicyParserError);
  assert.equal(caught.code, code);
  assert.deepEqual(caught.range, range);
  return caught;
};

const cannotSet = (
  target: object,
  property: PropertyKey,
  value: string | number | null,
): void => {
  assert.equal(Reflect.set(target, property, value), false);
};

test("kernel immediately snapshots and freezes exact parser limits", (): void => {
  const supplied = {
    maxNestingDepth: 20,
    maxSourceCodeUnits: 1_000,
    maxTokens: 100,
    maxWorkUnits: 200,
  };
  const kernel = createSqlParserKernel("select 1", supplied);

  assert.notEqual(kernel.limits, supplied);
  assert.deepEqual(kernel.limits, supplied);
  assert.ok(Object.isFrozen(kernel.limits));
  supplied.maxSourceCodeUnits = 1;
  supplied.maxTokens = 1;
  supplied.maxNestingDepth = 1;
  supplied.maxWorkUnits = 1;
  assert.deepEqual(kernel.limits, limits(1_000, 100, 20, 200));
  cannotSet(kernel.limits, "maxTokens", 1);
  assert.equal(kernel.limits.maxTokens, 100);

  const withExtra = {
    ...DEFAULT_SQL_PARSER_LIMITS,
    extra: 1,
  };
  expectParserError(
    () => createSqlParserKernel("select 1", withExtra),
    "invalid_configuration",
    { start: 0, end: 0 },
  );
});

test("kernel rejects non-numeric own limit values without coercion", (): void => {
  let coercionAttempts = 0;
  const throwingToString = {
    toString: (): string => {
      coercionAttempts++;
      throw new TypeError("limit toString must not run");
    },
  };
  const throwingPrimitive = {
    [Symbol.toPrimitive]: (): number => {
      coercionAttempts++;
      throw new TypeError("limit Symbol.toPrimitive must not run");
    },
  };
  type InvalidLimitValue =
    | bigint
    | boolean
    | number
    | object
    | string
    | symbol
    | null
    | undefined;
  const invalidValues: ReadonlyArray<Readonly<{
    label: string;
    value: InvalidLimitValue;
  }>> = [
    { label: "plain object", value: {} },
    { label: "throwing toString", value: throwingToString },
    { label: "throwing Symbol.toPrimitive", value: throwingPrimitive },
    { label: "function", value: (): void => undefined },
    { label: "symbol", value: Symbol("limit") },
    { label: "bigint", value: 1n },
    { label: "string", value: "1" },
    { label: "boolean", value: true },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
    { label: "fraction", value: 1.5 },
    { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "negative", value: -1 },
    { label: "zero", value: 0 },
  ];
  const fields: ReadonlyArray<keyof SqlParserLimits> = [
    "maxSourceCodeUnits",
    "maxTokens",
    "maxNestingDepth",
    "maxWorkUnits",
  ];

  for (const field of fields) {
    for (const invalid of invalidValues) {
      const supplied = limits(1_000, 100, 20, 200);
      Object.defineProperty(supplied, field, {
        configurable: true,
        enumerable: true,
        value: invalid.value,
        writable: true,
      });
      const attemptsBeforeValidation = coercionAttempts;
      const error = expectParserError(
        () => createSqlParserKernel("select 1", supplied),
        "invalid_configuration",
        { start: 0, end: 0 },
      );
      assert.match(error.message, new RegExp(field, "u"), invalid.label);
      assert.equal(
        coercionAttempts,
        attemptsBeforeValidation,
        invalid.label,
      );
    }
  }
});

test("kernel deeply owns and freezes every lexer token shape", (): void => {
  const sql = [
    " \n--line\n/*block*/ ",
    String.raw`plain "quoted" U&"d\0061t" `,
    "'ordinary'\n'continued' ",
    String.raw`E'\101' U&'\0061' N'national' B'1010' X'CAFE' `,
    "$tag$dollar$tag$ $1 12.5 0x1f 0b10 0o7 + , ; next",
  ].join("");
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);

  assert.ok(Object.isFrozen(kernel));
  assert.ok(Object.isFrozen(kernel.sourceTokens));
  assert.ok(Object.isFrozen(kernel.tokens));
  assert.equal(kernel.sourceTokens.map((token) => token.text).join(""), sql);
  assert.deepEqual(
    new Set(kernel.sourceTokens.map((token) => token.kind)),
    new Set([
      "comment",
      "identifier",
      "numeric",
      "operator",
      "parameter",
      "punctuation",
      "string",
      "whitespace",
    ]),
  );

  const stringStyles = new Set<string>();
  const numericForms = new Set<string>();
  const commentStyles = new Set<string>();
  let sawQuotedIdentifier = false;
  let sawUnicodeIdentifier = false;
  for (const token of kernel.sourceTokens) {
    assert.ok(Object.isFrozen(token));
    assert.ok(Object.isFrozen(token.range));
    assert.equal(sql.slice(token.range.start, token.range.end), token.text);
    cannotSet(token.range, "start", 999);
    cannotSet(token, "text", "changed");
    if (token.kind === "comment") {
      commentStyles.add(token.style);
    }
    if (token.kind === "identifier") {
      sawQuotedIdentifier ||= token.quoted;
      sawUnicodeIdentifier ||= token.unicodeEscaped;
    }
    if (token.kind === "numeric") {
      assert.equal(token.valid, true);
      if (token.valid) {
        numericForms.add(token.form);
      }
    }
    if (token.kind === "string") {
      stringStyles.add(token.style);
      assert.ok(Object.isFrozen(token.semanticSegments));
      for (const segment of token.semanticSegments) {
        assert.ok(Object.isFrozen(segment));
        assert.ok(Object.isFrozen(segment.range));
        cannotSet(segment, "value", "changed");
        cannotSet(segment.range, "end", 0);
      }
      cannotSet(token.semanticSegments, "0", null);
    }
  }

  assert.deepEqual(commentStyles, new Set(["block", "line"]));
  assert.equal(sawQuotedIdentifier, true);
  assert.equal(sawUnicodeIdentifier, true);
  assert.deepEqual(
    stringStyles,
    new Set([
      "bit",
      "dollar",
      "escape",
      "hex",
      "national",
      "ordinary",
      "unicode",
    ]),
  );
  assert.deepEqual(
    numericForms,
    new Set(["binary", "decimal", "hexadecimal", "octal"]),
  );
  cannotSet(kernel.sourceTokens, "0", null);
  cannotSet(kernel.tokens, "0", null);
  assert.equal(kernel.sourceTokens.map((token) => token.text).join(""), sql);
});

test("statements and delimiter lookup are deeply immutable and reciprocal", (): void => {
  const sql = "numeric /* gap */ (10, (2))[]; interval day to second(3)";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const lookup = kernel.delimiters.matchingIndexes;

  assert.ok(Object.isFrozen(kernel.delimiters));
  assert.ok(Object.isFrozen(lookup));
  assert.ok(Object.isFrozen(lookup.get));
  assert.ok(Object.isFrozen(kernel.statements));
  assert.equal("set" in lookup, false);
  assert.equal("delete" in lookup, false);
  assert.equal("clear" in lookup, false);
  assert.equal(kernel.delimiters.scanSteps, kernel.tokens.length);
  assert.equal(kernel.statements.length, 2);
  for (const statement of kernel.statements) {
    assert.ok(Object.isFrozen(statement));
    assert.ok(Object.isFrozen(statement.range));
    if (statement.terminatorRange !== null) {
      assert.ok(Object.isFrozen(statement.terminatorRange));
      cannotSet(statement.terminatorRange, "start", 999);
    }
    cannotSet(statement.range, "end", 0);
    cannotSet(statement, "endIndex", 0);
  }

  const openingIndexes = kernel.tokens.flatMap((token, index) =>
    token.text === "(" || token.text === "[" ? [index] : []
  );
  assert.equal(lookup.size, openingIndexes.length * 2);
  for (const openingIndex of openingIndexes) {
    const closingIndex = lookup.get(openingIndex);
    assert.notEqual(closingIndex, undefined);
    if (closingIndex !== undefined) {
      assert.equal(lookup.get(closingIndex), openingIndex);
    }
  }
  assert.equal(lookup.get(-1), undefined);
  assert.equal(lookup.get(kernel.tokens.length), undefined);
  cannotSet(lookup, "size", 0);
  cannotSet(kernel.statements, "0", null);
});

test("token limit reports the first excess before owned graph construction", (): void => {
  const exact = expectParserError(
    () => createSqlParserKernel("a b c", limits(100, 2, 8, 20)),
    "limit_tokens",
    { start: 4, end: 5 },
  );
  assert.match(exact.message, /token count 3 exceeds maxTokens=2/u);

  const kernelUrl = new URL(
    "./sql-policy-parser-kernel.ts",
    import.meta.url,
  ).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=192",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        const { createSqlParserKernel } = await import(${JSON.stringify(kernelUrl)});
        const tokenCount = 1_000_000;
        const sql = ",".repeat(tokenCount);
        try {
          createSqlParserKernel(sql, {
            maxNestingDepth: 8,
            maxSourceCodeUnits: sql.length,
            maxTokens: 1,
            maxWorkUnits: tokenCount + 1,
          });
          process.exitCode = 2;
        } catch (error) {
          process.stdout.write(JSON.stringify({
            code: error.code,
            message: error.message,
            range: error.range,
          }));
        }
      `,
    ],
    {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      timeout: 10_000,
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(
    probe.stdout,
    '{"code":"limit_tokens","message":"SQL parser token count 1000000 exceeds maxTokens=1","range":{"start":1,"end":2}}',
  );
});

test("delimiter construction is linear with repeated constant-time lookup", (): void => {
  const groups = 8_000;
  const sql = "(x)".repeat(groups);
  const kernel = createSqlParserKernel(
    sql,
    limits(sql.length, groups * 3, 8, groups * 3),
  );

  assert.equal(kernel.tokens.length, groups * 3);
  assert.equal(kernel.delimiters.scanSteps, groups * 3);
  assert.equal(kernel.delimiters.matchingIndexes.size, groups * 2);
  for (let group = 0; group < groups; group++) {
    const openIndex = group * 3;
    const closeIndex = openIndex + 2;
    assert.equal(kernel.delimiters.matchingIndexes.get(openIndex), closeIndex);
    assert.equal(kernel.delimiters.matchingIndexes.get(closeIndex), openIndex);
  }
});
