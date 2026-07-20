import assert from "node:assert/strict";
import test from "node:test";
import {
  lexSqlPolicyInfrastructure,
  SqlPolicyLexerError,
  type SqlIdentifierToken,
  type SqlNumericToken,
  type SqlPolicyToken,
  type SqlStringToken,
} from "./sql-policy-lexer.js";
import {
  executeExpenseSql,
  validateExpenseSql,
} from "./sql-policy.js";

const withoutTrivia = (
  tokens: ReadonlyArray<SqlPolicyToken>,
): ReadonlyArray<SqlPolicyToken> =>
  tokens.filter((token) =>
    token.kind !== "comment" && token.kind !== "whitespace",
  );

const numericToken = (sql: string): SqlNumericToken => {
  const tokens = withoutTrivia(lexSqlPolicyInfrastructure(sql).tokens);
  assert.equal(tokens.length, 1, sql);
  const token = tokens[0];
  assert.equal(token?.kind, "numeric", sql);
  return token as SqlNumericToken;
};

const identifierTokens = (
  sql: string,
): ReadonlyArray<SqlIdentifierToken> =>
  lexSqlPolicyInfrastructure(sql).tokens.filter(
    (token): token is SqlIdentifierToken => token.kind === "identifier",
  );

const stringTokens = (sql: string): ReadonlyArray<SqlStringToken> =>
  lexSqlPolicyInfrastructure(sql).tokens.filter(
    (token): token is SqlStringToken => token.kind === "string",
  );

const expectLexerError = (
  sql: string,
  code: SqlPolicyLexerError["code"],
): void => {
  assert.throws(
    () => lexSqlPolicyInfrastructure(sql),
    (error: unknown) =>
      error instanceof SqlPolicyLexerError
      && error.code === code
      && error.range.start >= 0
      && error.range.end > error.range.start
      && error.range.end <= sql.length,
    sql,
  );
};

test("lexer preserves every lexical state and statement boundary", (): void => {
  const sql = String.raw`
    SELECT 'ordinary''quote',
      E'a\\\'; still one statement',
      U&'!0061bc' UESCAPE '!',
      N'national',
      B'1010',
      X'CAFE',
      $$dollar ; ' " text$$,
      $tag$nested /* not comment */ -- not comment$tag$,
      "quoted""name",
      U&"d!0061ta" UESCAPE '!'
    /* outer ; /* nested */ complete */
    FROM ledger_entries;
    -- second statement
    SELECT 2`;
  const lexed = lexSqlPolicyInfrastructure(sql);

  assert.equal(lexed.statements.length, 2);
  assert.deepEqual(
    lexed.tokens
      .filter((token) => token.kind === "string")
      .map((token) => token.style),
    [
      "ordinary",
      "escape",
      "unicode",
      "national",
      "bit",
      "hex",
      "dollar",
      "dollar",
    ],
  );
  assert.deepEqual(
    lexed.tokens
      .filter((token) => token.kind === "comment")
      .map((token) => token.style),
    ["block", "line"],
  );
  assert.equal(
    identifierTokens(sql).find((token) => token.unicodeEscaped)?.normalized,
    "data",
  );
  assert.equal(lexed.statements[0]?.terminatorRange !== null, true);
  assert.equal(lexed.statements[1]?.terminatorRange, null);
});

test("newline-separated PostgreSQL strings continue losslessly in every supported state", (): void => {
  const cases: ReadonlyArray<Readonly<{
    sql: string;
    style: SqlStringToken["style"];
    value: string;
  }>> = [
    { sql: "'a'\n'b'", style: "ordinary", value: "ab" },
    { sql: "E'\\u0061'\n'\\x62'", style: "escape", value: "ab" },
    { sql: "U&'\\D83D'\n'\\DE00'", style: "unicode", value: "😀" },
    { sql: "N'a'\n'b'", style: "national", value: "ab" },
    { sql: "B'10'\n'01'", style: "bit", value: "1001" },
    { sql: "X'CA'\n'FE'", style: "hex", value: "CAFE" },
    { sql: "'a' -- continuation\n'b'", style: "ordinary", value: "ab" },
    { sql: "E'\\xC3'\n'\\xA9'", style: "escape", value: "é" },
  ];

  for (const expected of cases) {
    const strings = stringTokens(expected.sql);
    assert.equal(strings.length, 1, expected.sql);
    assert.equal(strings[0]?.style, expected.style, expected.sql);
    assert.equal(strings[0]?.semanticValue, expected.value, expected.sql);
    assert.equal(strings[0]?.semanticSegments.length, 2, expected.sql);
    assert.equal(strings[0]?.semanticSegments.map((segment) => segment.value).join(""), expected.value);
    assert.equal(strings[0]?.text, expected.sql, expected.sql);
  }

  for (const sql of ["'a' 'b'", "'a' /* newline\\ninside */ 'b'"]) {
    assert.equal(stringTokens(sql).length, 2, sql);
  }

  const semicolonControl = String.raw`E'a\\\'; FOR UPDATE'
'; still data'`;
  assert.equal(stringTokens(semicolonControl)[0]?.semanticValue.includes("; FOR UPDATE"), true);
  assert.equal(lexSqlPolicyInfrastructure(semicolonControl).statements.length, 1);
});

test("escape strings preserve a leading UTF-8 byte-order mark", (): void => {
  const byteOrderMark = "\uFEFF";
  const cases: ReadonlyArray<Readonly<{
    segmentValues: ReadonlyArray<string>;
    sql: string;
    value: string;
  }>> = [
    {
      segmentValues: [`${byteOrderMark}raw`],
      sql: `E'${byteOrderMark}raw'`,
      value: `${byteOrderMark}raw`,
    },
    {
      segmentValues: [`${byteOrderMark}escaped`],
      sql: String.raw`E'\xEF\xBB\xBFescaped'`,
      value: `${byteOrderMark}escaped`,
    },
    {
      segmentValues: ["", `${byteOrderMark}continued`],
      sql: String.raw`E'\xEF'
'\xBB\xBFcontinued'`,
      value: `${byteOrderMark}continued`,
    },
  ];

  for (const expected of cases) {
    const token = stringTokens(expected.sql)[0];
    assert.equal(token?.style, "escape", expected.sql);
    assert.equal(token?.semanticValue, expected.value, expected.sql);
    assert.deepEqual(
      token?.semanticSegments.map((segment) => segment.value),
      expected.segmentValues,
      expected.sql,
    );
  }
});

test("literal prefixes are recognized only at scanner token boundaries", (): void => {
  const boundaryCases: ReadonlyArray<Readonly<{
    sql: string;
    styles: ReadonlyArray<SqlStringToken["style"]>;
    texts: ReadonlyArray<string>;
    values: ReadonlyArray<string>;
  }>> = [
    {
      sql: String.raw`$E'\x61'`,
      styles: ["escape"],
      texts: ["$", String.raw`E'\x61'`],
      values: ["a"],
    },
    {
      sql: "$$x$$E'y'",
      styles: ["dollar", "escape"],
      texts: ["$$x$$", "E'y'"],
      values: ["x", "y"],
    },
    {
      sql: String.raw`$tag$x$tag$U&'\0079'`,
      styles: ["dollar", "unicode"],
      texts: ["$tag$x$tag$", String.raw`U&'\0079'`],
      values: ["x", "y"],
    },
    {
      sql: "$B'10'$N'n'$X'CA'",
      styles: ["bit", "national", "hex"],
      texts: ["$", "B'10'", "$", "N'n'", "$", "X'CA'"],
      values: ["10", "n", "CA"],
    },
  ];

  for (const expected of boundaryCases) {
    const tokens = withoutTrivia(
      lexSqlPolicyInfrastructure(expected.sql).tokens,
    );
    assert.deepEqual(
      tokens.map((token) => token.text),
      expected.texts,
      expected.sql,
    );
    const strings = tokens.filter(
      (token): token is SqlStringToken => token.kind === "string",
    );
    assert.deepEqual(
      strings.map((token) => token.style),
      expected.styles,
      expected.sql,
    );
    assert.deepEqual(
      strings.map((token) => token.semanticValue),
      expected.values,
      expected.sql,
    );
  }

  const identifierCases: ReadonlyArray<Readonly<{
    identifier: string;
    sql: string;
    stringStyle: SqlStringToken["style"];
  }>> = [
    { identifier: "foo$E", sql: "foo$E'x'", stringStyle: "ordinary" },
    {
      identifier: "foo$U",
      sql: String.raw`foo$U&'\0061'`,
      stringStyle: "ordinary",
    },
    {
      identifier: "δ$E",
      sql: "δ$E'x'",
      stringStyle: "ordinary",
    },
    {
      identifier: "foo$E",
      sql: "$$x$$foo$E'y'",
      stringStyle: "ordinary",
    },
  ];
  for (const expected of identifierCases) {
    const tokens = withoutTrivia(
      lexSqlPolicyInfrastructure(expected.sql).tokens,
    );
    const identifier = tokens.find(
      (token): token is SqlIdentifierToken => token.kind === "identifier",
    );
    const string = tokens.filter(
      (token): token is SqlStringToken => token.kind === "string",
    ).at(-1);
    assert.equal(identifier?.text, expected.identifier, expected.sql);
    assert.equal(string?.style, expected.stringStyle, expected.sql);
  }

  assert.throws(
    () => lexSqlPolicyInfrastructure("$1E'x'"),
    (error: unknown) =>
      error instanceof SqlPolicyLexerError
      && error.code === "invalid_parameter"
      && error.range.start === 0
      && error.range.end === 3,
  );
  const numericPrefix = withoutTrivia(
    lexSqlPolicyInfrastructure("1E'x'").tokens,
  );
  assert.equal(numericPrefix[0]?.kind, "numeric");
  assert.equal(
    numericPrefix[0]?.kind === "numeric" && numericPrefix[0].valid,
    false,
  );
  assert.equal(numericPrefix[1]?.kind, "string");
  assert.equal(
    numericPrefix[1]?.kind === "string" && numericPrefix[1].style,
    "ordinary",
  );
});

test("UESCAPE lookahead skips tokens and validates one decoded byte", (): void => {
  const cases: ReadonlyArray<Readonly<{ sql: string; value: string }>> = [
    { sql: "U&'!0061' UESCAPE '!'", value: "a" },
    { sql: "U&'#0061'/* outer /* nested */ */UESCAPE/* gap */'#'", value: "a" },
    { sql: String.raw`U&'!0061' -- gap
UESCAPE E'\x21'`, value: "a" },
    { sql: String.raw`U&'\0061' UESCAPE E'\\'`, value: "a" },
    { sql: String.raw`U&'!0061' UESCAPE E'\441'`, value: "a" },
    {
      sql: "U&'!0061' /* before */ UESCAPE /* after */ $escape$!$escape$",
      value: "a",
    },
    { sql: String.raw`U&'\0061' UESCAPE $q$\$q$`, value: "a" },
  ];
  for (const expected of cases) {
    const token = stringTokens(expected.sql)[0];
    assert.equal(token?.semanticValue, expected.value, expected.sql);
    assert.equal(token?.unicodeEscapeCharacter, expected.sql.includes("!0061")
      ? "!"
      : expected.sql.includes("#0061")
        ? "#"
        : "\\");
    assert.equal(token?.text, expected.sql);
  }

  const identifier = identifierTokens(
    "U&\"d!0061ta\" /* gap */ UESCAPE E'\\x21'",
  )[0];
  assert.equal(identifier?.normalized, "data");
  assert.equal(identifier?.unicodeEscapeCharacter, "!");
  const dollarIdentifier = identifierTokens(
    "U&\"d!0061ta\" UESCAPE $escape$!$escape$",
  )[0];
  assert.equal(dollarIdentifier?.normalized, "data");
  assert.equal(dollarIdentifier?.unicodeEscapeCharacter, "!");

  const invalid: ReadonlyArray<Readonly<{
    code: SqlPolicyLexerError["code"];
    sql: string;
  }>> = [
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE 'é'" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE 'ab'" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE '0'" },
    { code: "invalid_unicode_escape_character", sql: String.raw`U&'data' UESCAPE E'\t'` },
    { code: "invalid_unicode_escape_character", sql: String.raw`U&'data' UESCAPE E'\440'` },
    { code: "invalid_string_encoding", sql: String.raw`U&'data' UESCAPE E'\400'` },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE B'1'" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE" },
  ];
  for (const expected of invalid) {
    expectLexerError(expected.sql, expected.code);
  }

  const invalidDollar: ReadonlyArray<Readonly<{
    code: SqlPolicyLexerError["code"];
    sql: string;
  }>> = [
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $$$$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$!!$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$é$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$0$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$+$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$'$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$\"$q$" },
    { code: "invalid_unicode_escape_character", sql: "U&'data' UESCAPE $q$ $q$" },
    { code: "unterminated_dollar_string", sql: "U&'data' UESCAPE $q$!" },
  ];
  for (const expected of invalidDollar) {
    const literalStart = expected.sql.indexOf("$");
    assert.throws(
      () => lexSqlPolicyInfrastructure(expected.sql),
      (error: unknown) =>
        error instanceof SqlPolicyLexerError
        && error.code === expected.code
        && error.range.start === literalStart
        && error.range.end === expected.sql.length,
      expected.sql,
    );
  }
});

test("identifier tokens expose complete PostgreSQL names and qualification boundaries", (): void => {
  const sql = String.raw`
    public.evil$count,
    "Mi""xed".U&"d!0061ta" UESCAPE '!',
    δημόσιο.κλήση$,
    foo$tag$,
    U&"\D83D\DE00",
    U&"\+00D83D\+00DE00",
    U&"\+01F600"
  `;
  const lexed = lexSqlPolicyInfrastructure(sql);
  const identifiers = lexed.tokens.filter(
    (token): token is SqlIdentifierToken => token.kind === "identifier",
  );

  assert.deepEqual(
    identifiers.map((identifier) => identifier.normalized),
    [
      "public",
      "evil$count",
      "Mi\"xed",
      "data",
      "δημόσιο",
      "κλήση$",
      "foo$tag$",
      "😀",
      "😀",
      "😀",
    ],
  );
  assert.deepEqual(
    lexed.tokens
      .filter((token) => token.kind === "punctuation")
      .map((token) => token.text),
    [".", ",", ".", ",", ".", ",", ",", ",", ","],
  );
  assert.equal(identifiers[2]?.quoted, true);
  assert.equal(identifiers[3]?.unicodeEscapeCharacter, "!");
  assert.equal(identifiers[6]?.unicodeEscaped, false);
});

test("identifier normalization matches PostgreSQL ASCII folding and 63-byte names", (): void => {
  const exact = "A".repeat(63);
  const longAscii = "B".repeat(64);
  const longUtf8 = `${"c".repeat(62)}étail`;
  const quotedUtf8 = `${"Q".repeat(61)}😀tail`;
  const sql = `${exact} ${longAscii} ${longUtf8} "${quotedUtf8}" ÄBC`;
  const identifiers = identifierTokens(sql);

  assert.deepEqual(
    identifiers.map((token) => ({
      normalized: token.normalized,
      truncated: token.truncated,
      untruncatedNormalized: token.untruncatedNormalized,
    })),
    [
      {
        normalized: "a".repeat(63),
        truncated: false,
        untruncatedNormalized: "a".repeat(63),
      },
      {
        normalized: "b".repeat(63),
        truncated: true,
        untruncatedNormalized: "b".repeat(64),
      },
      {
        normalized: "c".repeat(62),
        truncated: true,
        untruncatedNormalized: longUtf8,
      },
      {
        normalized: "Q".repeat(61),
        truncated: true,
        untruncatedNormalized: quotedUtf8,
      },
      {
        normalized: "Äbc",
        truncated: false,
        untruncatedNormalized: "Äbc",
      },
    ],
  );
  assert.equal(identifiers[1]?.text, longAscii);
  assert.deepEqual(identifiers[1]?.range, {
    start: exact.length + 1,
    end: exact.length + 1 + longAscii.length,
  });

  const unicodeQuoted = identifierTokens(
    `U&"${"d".repeat(62)}\\00E9tail"`,
  )[0];
  assert.equal(unicodeQuoted?.normalized, "d".repeat(62));
  assert.equal(unicodeQuoted?.truncated, true);
});

test("parameters, operators, and punctuation use unambiguous tokens", (): void => {
  const sql = "$1::numeric[], value->>'key', x*-y, a@-b, left:=right, x=>y, $42, item[1:2];";
  const tokens = withoutTrivia(lexSqlPolicyInfrastructure(sql).tokens);

  assert.deepEqual(
    tokens.filter((token) => token.kind === "parameter").map((token) => ({
      positionText: token.positionText,
      text: token.text,
    })),
    [
      { positionText: "1", text: "$1" },
      { positionText: "42", text: "$42" },
    ],
  );
  assert.deepEqual(
    tokens.filter((token) => token.kind === "operator").map((token) => token.text),
    ["::", "->>", "*", "-", "@-", ":=", "=>"],
  );
  assert.deepEqual(
    tokens.filter((token) => token.kind === "punctuation").map((token) => token.text),
    ["[", "]", ",", ",", ",", ",", ",", ",", ",", "[", ":", "]", ";"],
  );
});

test("longest-match boundaries follow PostgreSQL for numbers, parameters, and dollar tags", (): void => {
  const cases: ReadonlyArray<Readonly<{
    kinds: ReadonlyArray<SqlPolicyToken["kind"]>;
    sql: string;
    texts: ReadonlyArray<string>;
  }>> = [
    {
      kinds: ["numeric", "parameter"],
      sql: "1$2",
      texts: ["1", "$2"],
    },
    {
      kinds: ["parameter", "parameter"],
      sql: "$1$2",
      texts: ["$1", "$2"],
    },
    {
      kinds: ["numeric", "string"],
      sql: "123$tag$body$tag$",
      texts: ["123", "$tag$body$tag$"],
    },
    {
      kinds: ["numeric", "string"],
      sql: "123$$body$$",
      texts: ["123", "$$body$$"],
    },
    {
      kinds: ["numeric", "parameter"],
      sql: "1_2$3",
      texts: ["1_2", "$3"],
    },
    {
      kinds: ["numeric", "parameter"],
      sql: "1.2$3",
      texts: ["1.2", "$3"],
    },
    {
      kinds: ["numeric", "parameter"],
      sql: "1e+2$3",
      texts: ["1e+2", "$3"],
    },
    {
      kinds: ["numeric", "string"],
      sql: "1_2$tag$body$tag$",
      texts: ["1_2", "$tag$body$tag$"],
    },
  ];
  for (const expected of cases) {
    const tokens = withoutTrivia(
      lexSqlPolicyInfrastructure(expected.sql).tokens,
    );
    assert.deepEqual(tokens.map((token) => token.kind), expected.kinds, expected.sql);
    assert.deepEqual(tokens.map((token) => token.text), expected.texts, expected.sql);
    let rangeStart = 0;
    for (const token of tokens) {
      assert.deepEqual(token.range, {
        start: rangeStart,
        end: rangeStart + token.text.length,
      }, expected.sql);
      rangeStart = token.range.end;
    }
  }

  for (const sql of [
    "0xFFé",
    "0xFF$2",
    "0xFF$tag$body$tag$",
    "0b10tail",
    "0b10$2",
    "1_foo",
    "1e2$3",
    ".1e2$3",
    "1_$2",
    "1e$2",
    "1e2_$3",
    "1__$$x$$",
    "1.2_$3",
    "1e+2_$3",
  ]) {
    const token = numericToken(sql);
    assert.equal(token.valid, false, sql);
    assert.deepEqual(token.range, { start: 0, end: sql.length }, sql);
    if (!token.valid) {
      assert.equal(token.diagnostic.message.includes("PostgreSQL numeric"), true);
    }
  }
  for (const sql of ["$1evil", "$1é", "$1e$2"]) {
    assert.throws(
      () => lexSqlPolicyInfrastructure(sql),
      (error: unknown) =>
        error instanceof SqlPolicyLexerError
        && error.code === "invalid_parameter"
        && error.range.start === 0
        && error.range.end === sql.length,
      sql,
    );
  }

  const partialJunk = withoutTrivia(
    lexSqlPolicyInfrastructure("1_.0 1e+$2").tokens,
  );
  assert.deepEqual(
    partialJunk.map((token) => ({
      range: token.range,
      text: token.text,
    })),
    [
      { range: { start: 0, end: 2 }, text: "1_" },
      { range: { start: 2, end: 4 }, text: ".0" },
      { range: { start: 5, end: 8 }, text: "1e+" },
      { range: { start: 8, end: 10 }, text: "$2" },
    ],
  );
});

test("parameter and operator limits report exact PostgreSQL ranges", (): void => {
  const validSql = "$0 $0001 $2147483647";
  const parameters = lexSqlPolicyInfrastructure(validSql).tokens.filter(
    (token) => token.kind === "parameter",
  );
  assert.deepEqual(
    parameters.map((token) => ({
      position: token.position,
      positionText: token.positionText,
    })),
    [
      { position: 0, positionText: "0" },
      { position: 1, positionText: "0001" },
      { position: 2_147_483_647, positionText: "2147483647" },
    ],
  );
  assert.deepEqual(
    withoutTrivia(lexSqlPolicyInfrastructure("$-1").tokens).map((token) => token.text),
    ["$", "-", "1"],
  );

  for (const sql of ["$2147483648", "$0002147483648", "$999999999999999999999"]) {
    assert.throws(
      () => lexSqlPolicyInfrastructure(sql),
      (error: unknown) =>
        error instanceof SqlPolicyLexerError
        && error.code === "parameter_number_too_large"
        && error.range.start === 0
        && error.range.end === sql.length,
      sql,
    );
  }

  const validOperator = "?".repeat(63);
  assert.equal(
    withoutTrivia(lexSqlPolicyInfrastructure(validOperator).tokens)[0]?.text,
    validOperator,
  );
  const longOperator = "?".repeat(64);
  assert.throws(
    () => lexSqlPolicyInfrastructure(longOperator),
    (error: unknown) =>
      error instanceof SqlPolicyLexerError
      && error.code === "operator_too_long"
      && error.range.start === 0
      && error.range.end === longOperator.length,
  );
});

test("PostgreSQL 18 valid numeric forms remain single normalized tokens", (): void => {
  const cases: ReadonlyArray<Readonly<{
    form: "binary" | "decimal" | "hexadecimal" | "octal";
    normalized: string;
    sql: string;
  }>> = [
    { form: "decimal", normalized: "42", sql: "42" },
    { form: "decimal", normalized: "3.5", sql: "3.5" },
    { form: "decimal", normalized: "4.", sql: "4." },
    { form: "decimal", normalized: ".001", sql: ".001" },
    { form: "decimal", normalized: "5e2", sql: "5e2" },
    { form: "decimal", normalized: "1.925e-3", sql: "1.925e-3" },
    { form: "decimal", normalized: "1500000000", sql: "1_500_000_000" },
    { form: "decimal", normalized: "1.618034", sql: "1.618_034" },
    { form: "decimal", normalized: ".12", sql: ".1_2" },
    { form: "binary", normalized: "0b1000100000000000", sql: "0b10001000_00000000" },
    { form: "binary", normalized: "0b101", sql: "0b_1_01" },
    { form: "octal", normalized: "0o1755", sql: "0o_1_755" },
    { form: "hexadecimal", normalized: "0xffffffff", sql: "0xFFFF_FFFF" },
    { form: "hexadecimal", normalized: "0xcafe", sql: "0XCAFE" },
  ];

  for (const expected of cases) {
    const token = numericToken(expected.sql);
    assert.equal(token.valid, true, expected.sql);
    if (token.valid) {
      assert.equal(token.form, expected.form, expected.sql);
      assert.equal(token.normalized, expected.normalized, expected.sql);
    }
  }
});

test("invalid numeric candidates stay single diagnostic tokens", (): void => {
  const cases: ReadonlyArray<Readonly<{
    code:
      | "invalid_digit"
      | "invalid_exponent"
      | "invalid_separator"
      | "missing_digits"
      | "trailing_junk";
    sql: string;
  }>> = [
    { code: "invalid_separator", sql: "1__0" },
    { code: "invalid_separator", sql: "1_" },
    { code: "invalid_separator", sql: "1._0" },
    { code: "invalid_separator", sql: "1e_2" },
    { code: "invalid_separator", sql: "1e2_" },
    { code: "missing_digits", sql: "0x" },
    { code: "invalid_separator", sql: "0b_" },
    { code: "invalid_digit", sql: "0b102" },
    { code: "invalid_digit", sql: "0o89" },
    { code: "invalid_digit", sql: "0xCAFEG" },
    { code: "invalid_exponent", sql: "1e+" },
    { code: "trailing_junk", sql: "123evil" },
    { code: "trailing_junk", sql: "0z12" },
  ];

  for (const expected of cases) {
    const token = numericToken(expected.sql);
    assert.equal(token.valid, false, expected.sql);
    if (!token.valid) {
      assert.equal(token.diagnostic.code, expected.code, expected.sql);
      assert.match(token.diagnostic.message, /Invalid PostgreSQL numeric literal/u);
    }
  }

  const noFakeCall = withoutTrivia(
    lexSqlPolicyInfrastructure("123evil(1)").tokens,
  );
  assert.deepEqual(
    noFakeCall.map((token) => token.kind),
    ["numeric", "punctuation", "numeric", "punctuation"],
  );
});

test("escape strings validate Unicode, surrogate, and UTF-8 semantics", (): void => {
  const valid: ReadonlyArray<Readonly<{ sql: string; value: string }>> = [
    { sql: String.raw`E'\u0061'`, value: "a" },
    { sql: String.raw`E'\U0001F600'`, value: "😀" },
    { sql: String.raw`E'\uD83D\uDE00'`, value: "😀" },
    { sql: String.raw`E'\U0000D83D\U0000DE00'`, value: "😀" },
    { sql: String.raw`E'\101\x42\n'`, value: "AB\n" },
    { sql: String.raw`E'\401'`, value: "\u0001" },
    { sql: String.raw`E'\477'`, value: "?" },
    { sql: String.raw`E'\1000'`, value: "@0" },
    { sql: "E'\\703'\n'\\251'", value: "é" },
  ];
  for (const expected of valid) {
    assert.equal(stringTokens(expected.sql)[0]?.semanticValue, expected.value, expected.sql);
  }

  const invalid: ReadonlyArray<Readonly<{
    code: SqlPolicyLexerError["code"];
    sql: string;
  }>> = [
    { code: "invalid_unicode_escape", sql: String.raw`E'\u12'` },
    { code: "invalid_unicode_escape", sql: String.raw`E'\u12ZZ'` },
    { code: "invalid_unicode_escape", sql: String.raw`E'\U00110000'` },
    { code: "invalid_unicode_escape", sql: String.raw`E'\u0000'` },
    { code: "invalid_unicode_surrogate", sql: String.raw`E'\uD83D'` },
    { code: "invalid_unicode_surrogate", sql: String.raw`E'\uDE00'` },
    { code: "invalid_unicode_surrogate", sql: String.raw`E'\uD83D\u0061'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\x00'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\000'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\400'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\600'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\777'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\x80'` },
    { code: "invalid_string_encoding", sql: String.raw`E'\xC3x'` },
    { code: "invalid_string_encoding", sql: "E'\\xC3'\n''" },
  ];
  for (const expected of invalid) {
    expectLexerError(expected.sql, expected.code);
  }
});

test("token ranges form an exact lossless partition of the input", (): void => {
  const sql = String.raw`SELECT E'x\';;' AS value /* nested /* block */ */; ;
-- comment-only segment
SELECT U&"d!0061ta" UESCAPE '!' FROM foo$bar$`;
  const lexed = lexSqlPolicyInfrastructure(sql);

  assert.equal(lexed.tokens.map((token) => token.text).join(""), sql);
  let nextStart = 0;
  for (const token of lexed.tokens) {
    assert.equal(token.range.start, nextStart);
    assert.equal(token.text, sql.slice(token.range.start, token.range.end));
    nextStart = token.range.end;
  }
  assert.equal(nextStart, sql.length);
  assert.equal(lexed.statements.length, 2);
  for (const statement of lexed.statements) {
    assert.equal(
      statement.tokens.map((token) => token.text).join(""),
      sql.slice(statement.range.start, statement.range.end),
    );
  }
});

test("lexer raises actionable errors for invalid lexical constructs", (): void => {
  const cases: ReadonlyArray<Readonly<{
    code:
      | "invalid_character"
      | "invalid_parameter"
      | "invalid_quoted_identifier"
      | "invalid_unicode_escape"
      | "invalid_unicode_escape_character"
      | "invalid_unicode_surrogate"
      | "unterminated_block_comment"
      | "unterminated_dollar_string"
      | "unterminated_quoted_identifier"
      | "unterminated_string";
    sql: string;
  }>> = [
    { code: "unterminated_string", sql: "SELECT 'open" },
    { code: "unterminated_string", sql: "SELECT E'open\\" },
    { code: "unterminated_quoted_identifier", sql: "SELECT \"open" },
    { code: "invalid_quoted_identifier", sql: "SELECT \"\"" },
    { code: "unterminated_dollar_string", sql: "SELECT $tag$open" },
    { code: "unterminated_block_comment", sql: "SELECT /* open" },
    { code: "invalid_unicode_escape", sql: String.raw`SELECT U&"\ZZZZ"` },
    { code: "invalid_unicode_escape", sql: String.raw`SELECT U&"\12"` },
    { code: "invalid_unicode_surrogate", sql: String.raw`SELECT U&"\D800"` },
    { code: "invalid_unicode_escape_character", sql: "SELECT U&\"data\" UESCAPE '0'" },
    { code: "invalid_parameter", sql: "SELECT $1evil(1)" },
    { code: "invalid_character", sql: "SELECT \0" },
    { code: "invalid_character", sql: `SELECT E'${String.fromCharCode(0xD800)}'` },
  ];

  for (const expected of cases) {
    assert.throws(
      () => lexSqlPolicyInfrastructure(expected.sql),
      (error: unknown) =>
        error instanceof SqlPolicyLexerError
        && error.code === expected.code
        && error.range.end > error.range.start
        && error.message.includes("offset"),
      expected.sql,
    );
  }

  assert.throws(
    () => lexSqlPolicyInfrastructure(String.raw`SELECT U&"\12"`),
    (error: unknown) =>
      error instanceof SqlPolicyLexerError
      && error.range.end <= String.raw`SELECT U&"\12"`.length,
  );

  assert.deepEqual(
    stringTokens("B'102' X'CAFG'").map((token) => token.semanticValue),
    ["102", "CAFG"],
  );
});

test("the lexer remains dormant and current policy execution is unchanged", async (): Promise<void> => {
  const sql = "SELECT * FROM ledger_entries FOR SHARE";
  const validated = validateExpenseSql(sql);
  assert.equal(validated.statements.length, 1);

  let callbackCount = 0;
  const executed = await executeExpenseSql(sql, async (statementSql) => {
    callbackCount++;
    assert.equal(statementSql, sql);
    return {
      command: "SELECT",
      rowCount: 0,
      rows: [],
    };
  });

  assert.equal(callbackCount, 1);
  assert.equal(executed.statements.length, 1);
});
