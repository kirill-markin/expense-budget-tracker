export type SqlSourceRange = Readonly<{
  start: number;
  end: number;
}>;

type SqlTokenBase = Readonly<{
  range: SqlSourceRange;
  text: string;
}>;

export type SqlWhitespaceToken = SqlTokenBase & Readonly<{
  kind: "whitespace";
}>;

export type SqlCommentToken = SqlTokenBase & Readonly<{
  kind: "comment";
  style: "block" | "line";
}>;

export type SqlIdentifierToken = SqlTokenBase & Readonly<{
  kind: "identifier";
  normalized: string;
  quoted: boolean;
  truncated: boolean;
  untruncatedNormalized: string;
  unicodeEscaped: boolean;
  unicodeEscapeCharacter: string | null;
}>;

export type SqlStringSegment = Readonly<{
  range: SqlSourceRange;
  value: string;
}>;

export type SqlStringToken = SqlTokenBase & Readonly<{
  kind: "string";
  style:
    | "bit"
    | "dollar"
    | "escape"
    | "hex"
    | "national"
    | "ordinary"
    | "unicode";
  dollarTag: string | null;
  semanticSegments: ReadonlyArray<SqlStringSegment>;
  semanticValue: string;
  unicodeEscapeCharacter: string | null;
}>;

export type SqlParameterToken = SqlTokenBase & Readonly<{
  kind: "parameter";
  position: number;
  positionText: string;
}>;

export type SqlValidNumericToken = SqlTokenBase & Readonly<{
  kind: "numeric";
  form: "binary" | "decimal" | "hexadecimal" | "octal";
  normalized: string;
  valid: true;
}>;

export type SqlInvalidNumericCode =
  | "invalid_digit"
  | "invalid_exponent"
  | "invalid_separator"
  | "missing_digits"
  | "trailing_junk";

export type SqlInvalidNumericToken = SqlTokenBase & Readonly<{
  kind: "numeric";
  diagnostic: Readonly<{
    code: SqlInvalidNumericCode;
    message: string;
  }>;
  valid: false;
}>;

export type SqlNumericToken = SqlValidNumericToken | SqlInvalidNumericToken;

export type SqlOperatorToken = SqlTokenBase & Readonly<{
  kind: "operator";
}>;

export type SqlPunctuationToken = SqlTokenBase & Readonly<{
  kind: "punctuation";
}>;

export type SqlPolicyToken =
  | SqlCommentToken
  | SqlIdentifierToken
  | SqlNumericToken
  | SqlOperatorToken
  | SqlParameterToken
  | SqlPunctuationToken
  | SqlStringToken
  | SqlWhitespaceToken;

export type SqlLexedStatement = Readonly<{
  range: SqlSourceRange;
  terminatorRange: SqlSourceRange | null;
  tokens: ReadonlyArray<SqlPolicyToken>;
}>;

export type SqlLexedScript = Readonly<{
  sql: string;
  statements: ReadonlyArray<SqlLexedStatement>;
  tokens: ReadonlyArray<SqlPolicyToken>;
}>;

export type SqlPolicyLexerErrorCode =
  | "internal_invariant"
  | "invalid_character"
  | "invalid_escape_string"
  | "invalid_parameter"
  | "invalid_quoted_identifier"
  | "invalid_string_encoding"
  | "invalid_unicode_escape"
  | "invalid_unicode_escape_character"
  | "invalid_unicode_surrogate"
  | "operator_too_long"
  | "parameter_number_too_large"
  | "unterminated_block_comment"
  | "unterminated_dollar_string"
  | "unterminated_quoted_identifier"
  | "unterminated_string";

export class SqlPolicyLexerError extends Error {
  readonly code: SqlPolicyLexerErrorCode;
  readonly range: SqlSourceRange;

  constructor(
    code: SqlPolicyLexerErrorCode,
    message: string,
    range: SqlSourceRange,
  ) {
    super(message);
    this.code = code;
    this.range = range;
  }
}

type UnicodeEscapeClause = Readonly<{
  end: number;
  escapeCharacter: string;
}>;

type QuotedSegment = Readonly<{
  bodyRange: SqlSourceRange;
  range: SqlSourceRange;
}>;

type QuotedSequence = Readonly<{
  end: number;
  segments: ReadonlyArray<QuotedSegment>;
}>;

type NumericScan = Readonly<{
  end: number;
  token: SqlNumericToken;
}>;

const MAX_IDENTIFIER_BYTES = 63;
const MAX_PARAMETER_NUMBER = 2_147_483_647n;

const OPERATOR_CHARACTERS = new Set(
  Array.from("+-*/<>=~!@#%^&|`?"),
);

const PUNCTUATION_CHARACTERS = new Set(
  Array.from("()[],;{}"),
);

const readCodePoint = (
  value: string,
  index: number,
): Readonly<{ character: string; width: number }> | null => {
  const codePoint = value.codePointAt(index);
  if (codePoint === undefined) {
    return null;
  }
  const character = String.fromCodePoint(codePoint);
  return { character, width: character.length };
};

const isIdentifierStart = (value: string): boolean => {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined
    && (/[A-Za-z_]/u.test(value) || codePoint >= 0x80);
};

const isIdentifierPart = (value: string): boolean =>
  isIdentifierStart(value) || /[0-9$]/u.test(value);

const isSqlWhitespace = (value: string): boolean =>
  /[\t\n\v\f\r ]/u.test(value);

const invalidUtf16Index = (value: string): number => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xDC00 || next > 0xDFFF) {
        return index;
      }
      index++;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return index;
    }
  }
  return -1;
};

const lexerError = (
  code: SqlPolicyLexerErrorCode,
  message: string,
  start: number,
  end: number,
): never => {
  throw new SqlPolicyLexerError(code, message, { start, end });
};

const readIdentifierEnd = (sql: string, start: number): number => {
  const first = readCodePoint(sql, start);
  if (first === null || !isIdentifierStart(first.character)) {
    return start;
  }
  let index = start + first.width;
  while (index < sql.length) {
    const current = readCodePoint(sql, index);
    if (current === null || !isIdentifierPart(current.character)) {
      break;
    }
    index += current.width;
  }
  return index;
};

const foldUnquotedIdentifier = (value: string): string =>
  value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );

const truncateUtf8 = (
  value: string,
  maximumBytes: number,
): Readonly<{ truncated: boolean; value: string }> => {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) {
      return { truncated: true, value: result };
    }
    result += character;
    bytes += characterBytes;
  }
  return { truncated: false, value: result };
};

const identifierNormalization = (
  value: string,
  quoted: boolean,
): Readonly<{
  normalized: string;
  truncated: boolean;
  untruncatedNormalized: string;
}> => {
  const untruncatedNormalized = quoted
    ? value
    : foldUnquotedIdentifier(value);
  const truncated = truncateUtf8(
    untruncatedNormalized,
    MAX_IDENTIFIER_BYTES,
  );
  return {
    normalized: truncated.value,
    truncated: truncated.truncated,
    untruncatedNormalized,
  };
};

const readQuotedSegment = (
  sql: string,
  quoteIndex: number,
  quote: "'" | "\"",
  doubledQuotes: boolean,
  backslashEscapes: boolean,
  errorCode: "unterminated_quoted_identifier" | "unterminated_string",
): QuotedSegment => {
  let index = quoteIndex + 1;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (backslashEscapes && current === "\\" && next !== undefined) {
      index += 2;
    } else if (doubledQuotes && current === quote && next === quote) {
      index += 2;
    } else if (current === quote) {
      return {
        bodyRange: { start: quoteIndex + 1, end: index },
        range: { start: quoteIndex, end: index + 1 },
      };
    } else {
      index += readCodePoint(sql, index)?.width ?? 1;
    }
  }
  return lexerError(
    errorCode,
    `Unterminated ${quote === "'" ? "string" : "quoted identifier"} starting at offset ${String(quoteIndex)}`,
    quoteIndex,
    sql.length,
  );
};

const readQuoteContinuation = (
  sql: string,
  start: number,
): number | null => {
  let hasNewline = false;
  let index = start;
  while (index < sql.length) {
    if (isSqlWhitespace(sql[index] ?? "")) {
      hasNewline ||= sql[index] === "\n" || sql[index] === "\r";
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      index += 2;
      while (
        index < sql.length
        && sql[index] !== "\n"
        && sql[index] !== "\r"
      ) {
        index += readCodePoint(sql, index)?.width ?? 1;
      }
      continue;
    }
    break;
  }
  return hasNewline && sql[index] === "'" ? index : null;
};

const readQuotedSequence = (
  sql: string,
  tokenStart: number,
  firstQuoteIndex: number,
  doubledQuotes: boolean,
  backslashEscapes: boolean,
): QuotedSequence => {
  const segments: Array<QuotedSegment> = [];
  let quoteIndex = firstQuoteIndex;
  while (true) {
    const segment = readQuotedSegment(
      sql,
      quoteIndex,
      "'",
      doubledQuotes,
      backslashEscapes,
      "unterminated_string",
    );
    segments.push({
      bodyRange: segment.bodyRange,
      range: {
        start: segments.length === 0 ? tokenStart : segment.range.start,
        end: segment.range.end,
      },
    });
    const continuation = readQuoteContinuation(sql, segment.range.end);
    if (continuation === null) {
      return { end: segment.range.end, segments };
    }
    quoteIndex = continuation;
  }
};

const readBlockCommentEnd = (sql: string, start: number): number => {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth--;
      index += 2;
    } else {
      index += readCodePoint(sql, index)?.width ?? 1;
    }
  }
  if (depth !== 0) {
    return lexerError(
      "unterminated_block_comment",
      `Unterminated block comment starting at offset ${String(start)}`,
      start,
      sql.length,
    );
  }
  return index;
};

const readTriviaEnd = (sql: string, start: number): number => {
  let index = start;
  while (index < sql.length) {
    if (isSqlWhitespace(sql[index] ?? "")) {
      index++;
    } else if (sql.startsWith("--", index)) {
      index += 2;
      while (
        index < sql.length
        && sql[index] !== "\n"
        && sql[index] !== "\r"
      ) {
        index += readCodePoint(sql, index)?.width ?? 1;
      }
    } else if (sql.startsWith("/*", index)) {
      index = readBlockCommentEnd(sql, index);
    } else {
      break;
    }
  }
  return index;
};

const decodeDoubledQuotes = (
  sql: string,
  range: SqlSourceRange,
  quote: "'" | "\"",
): string => sql.slice(range.start, range.end).replaceAll(quote + quote, quote);

const appendUtf8 = (bytes: Array<number>, value: string): void => {
  bytes.push(...Buffer.from(value, "utf8"));
};

const escapeUnicodeValue = (
  sql: string,
  escapeIndex: number,
  prefix: "U" | "u",
  bodyEnd: number,
): Readonly<{ end: number; value: number }> => {
  const digitsLength = prefix === "u" ? 4 : 8;
  const end = escapeIndex + 2 + digitsLength;
  const digits = sql.slice(escapeIndex + 2, end);
  if (end > bodyEnd || !/^[0-9A-Fa-f]+$/u.test(digits)) {
    return lexerError(
      "invalid_unicode_escape",
      `Invalid ${prefix === "u" ? "\\uXXXX" : "\\UXXXXXXXX"} escape at offset ${String(escapeIndex)}`,
      escapeIndex,
      Math.min(end, bodyEnd),
    );
  }
  const value = Number.parseInt(digits, 16);
  if (value === 0 || value > 0x10FFFF) {
    return lexerError(
      "invalid_unicode_escape",
      `Unicode escape at offset ${String(escapeIndex)} is outside PostgreSQL's valid code-point range`,
      escapeIndex,
      end,
    );
  }
  return { end, value };
};

const decodeEscapeSegmentBytes = (
  sql: string,
  range: SqlSourceRange,
): ReadonlyArray<number> => {
  const bytes: Array<number> = [];
  for (let index = range.start; index < range.end;) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      bytes.push(0x27);
      index += 2;
      continue;
    }
    if (sql[index] !== "\\") {
      const current = readCodePoint(sql, index);
      if (current === null) {
        break;
      }
      appendUtf8(bytes, current.character);
      index += current.width;
      continue;
    }

    const escaped = readCodePoint(sql, index + 1);
    if (escaped === null) {
      return lexerError(
        "invalid_escape_string",
        `Incomplete escape sequence at offset ${String(index)}`,
        index,
        range.end,
      );
    }
    if (escaped.character === "u" || escaped.character === "U") {
      const escapeStart = index;
      const first = escapeUnicodeValue(
        sql,
        index,
        escaped.character,
        range.end,
      );
      let value = first.value;
      index = first.end;
      if (value >= 0xD800 && value <= 0xDBFF) {
        if (
          sql[index] !== "\\"
          || (sql[index + 1] !== "u" && sql[index + 1] !== "U")
        ) {
          return lexerError(
            "invalid_unicode_surrogate",
            `High surrogate at offset ${String(escapeStart)} is not followed by a Unicode low surrogate`,
            escapeStart,
            Math.min(first.end, range.end),
          );
        }
        const secondPrefix = sql[index + 1] as "U" | "u";
        const second = escapeUnicodeValue(
          sql,
          index,
          secondPrefix,
          range.end,
        );
        if (second.value < 0xDC00 || second.value > 0xDFFF) {
          return lexerError(
            "invalid_unicode_surrogate",
            `Invalid Unicode surrogate pair at offset ${String(index)}`,
            index,
            second.end,
          );
        }
        value = 0x10000
          + ((value - 0xD800) << 10)
          + second.value
          - 0xDC00;
        index = second.end;
      } else if (value >= 0xDC00 && value <= 0xDFFF) {
        return lexerError(
          "invalid_unicode_surrogate",
          `Unexpected Unicode low surrogate at offset ${String(escapeStart)}`,
          escapeStart,
          index,
        );
      }
      appendUtf8(bytes, String.fromCodePoint(value));
      continue;
    }
    if (/[0-7]/u.test(escaped.character)) {
      let end = index + 2;
      while (end < range.end && end < index + 4 && /[0-7]/u.test(sql[end] ?? "")) {
        end++;
      }
      bytes.push(Number.parseInt(sql.slice(index + 1, end), 8) & 0xFF);
      index = end;
      continue;
    }
    if (escaped.character === "x" && /[0-9A-Fa-f]/u.test(sql[index + 2] ?? "")) {
      let end = index + 3;
      if (/[0-9A-Fa-f]/u.test(sql[end] ?? "")) {
        end++;
      }
      bytes.push(Number.parseInt(sql.slice(index + 2, end), 16));
      index = end;
      continue;
    }
    const escapedValues: Readonly<Record<string, number>> = {
      b: 0x08,
      f: 0x0C,
      n: 0x0A,
      r: 0x0D,
      t: 0x09,
      v: 0x0B,
    };
    const mapped = escapedValues[escaped.character];
    if (mapped === undefined) {
      appendUtf8(bytes, escaped.character);
    } else {
      bytes.push(mapped);
    }
    index += 1 + escaped.width;
  }
  return bytes;
};

const decodeEscapeSegments = (
  sql: string,
  segments: ReadonlyArray<QuotedSegment>,
): ReadonlyArray<string> => {
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  const values: Array<string> = [];
  for (const [segmentIndex, segment] of segments.entries()) {
    const bytes = decodeEscapeSegmentBytes(sql, segment.bodyRange);
    const nulIndex = bytes.indexOf(0);
    if (nulIndex !== -1) {
      return lexerError(
        "invalid_string_encoding",
        `NUL produced by escape string segment at offset ${String(segment.bodyRange.start)}`,
        segment.bodyRange.start,
        segment.bodyRange.end,
      );
    }
    try {
      values.push(decoder.decode(
        Uint8Array.from(bytes),
        { stream: segmentIndex < segments.length - 1 },
      ));
    } catch {
      const tokenRange = {
        start: segments[0]?.range.start ?? segment.bodyRange.start,
        end: segments.at(-1)?.range.end ?? segment.bodyRange.end,
      };
      return lexerError(
        "invalid_string_encoding",
        `Escape string is not valid UTF-8 near offset ${String(segment.bodyRange.start)}`,
        tokenRange.start,
        tokenRange.end,
      );
    }
  }
  return values;
};

const readUnicodeEscapeClause = (
  sql: string,
  quotedEnd: number,
): UnicodeEscapeClause => {
  const keywordStart = readTriviaEnd(sql, quotedEnd);
  const keywordEnd = readIdentifierEnd(sql, keywordStart);
  if (
    foldUnquotedIdentifier(sql.slice(keywordStart, keywordEnd)) !== "uescape"
  ) {
    return { end: quotedEnd, escapeCharacter: "\\" };
  }
  const literalStart = readTriviaEnd(sql, keywordEnd);
  const quotedStyle = (
    (sql[literalStart] === "e" || sql[literalStart] === "E")
    && sql[literalStart + 1] === "'"
  )
    ? "escape"
    : sql[literalStart] === "'"
      ? "ordinary"
      : null;
  const dollarTag = readDollarTag(sql, literalStart);
  if (quotedStyle === null && dollarTag === null) {
    const errorStart = literalStart < sql.length ? literalStart : keywordStart;
    return lexerError(
      "invalid_unicode_escape_character",
      `UESCAPE at offset ${String(keywordStart)} must be followed by one simple string literal`,
      errorStart,
      literalStart < sql.length ? literalStart + 1 : keywordEnd,
    );
  }
  let literalEnd: number;
  let escapeCharacter: string;
  if (dollarTag !== null) {
    const closingStart = sql.indexOf(
      dollarTag,
      literalStart + dollarTag.length,
    );
    if (closingStart === -1) {
      return lexerError(
        "unterminated_dollar_string",
        `Unterminated dollar-quoted string ${dollarTag} starting at offset ${String(literalStart)}`,
        literalStart,
        sql.length,
      );
    }
    literalEnd = closingStart + dollarTag.length;
    escapeCharacter = sql.slice(
      literalStart + dollarTag.length,
      closingStart,
    );
  } else {
    const sequence = readQuotedSequence(
      sql,
      literalStart,
      literalStart + (quotedStyle === "escape" ? 1 : 0),
      true,
      quotedStyle === "escape",
    );
    const values = quotedStyle === "escape"
      ? decodeEscapeSegments(sql, sequence.segments)
      : sequence.segments.map((segment) =>
        decodeDoubledQuotes(sql, segment.bodyRange, "'"),
      );
    literalEnd = sequence.end;
    escapeCharacter = values.join("");
  }
  if (
    Buffer.byteLength(escapeCharacter, "utf8") !== 1
    || /[0-9A-Fa-f+'"\t\n\v\f\r ]/u.test(escapeCharacter)
  ) {
    return lexerError(
      "invalid_unicode_escape_character",
      `Invalid Unicode escape character at offset ${String(literalStart)}`,
      literalStart,
      literalEnd,
    );
  }
  return { end: literalEnd, escapeCharacter };
};

const unicodeCodePoint = (
  digits: string,
  start: number,
  end: number,
): number => {
  if (!/^[0-9A-Fa-f]+$/u.test(digits)) {
    return lexerError(
      "invalid_unicode_escape",
      `Invalid Unicode escape at offset ${String(start)}`,
      start,
      end,
    );
  }
  const value = Number.parseInt(digits, 16);
  if (value === 0 || value > 0x10FFFF) {
    return lexerError(
      "invalid_unicode_escape",
      `Unicode escape at offset ${String(start)} is outside the supported code-point range`,
      start,
      end,
    );
  }
  return value;
};

const readUnicodeEscapedCodePoint = (
  sql: string,
  escapeIndex: number,
  bodyEnd: number,
): Readonly<{ next: number; value: number }> => {
  const extended = sql[escapeIndex + 1] === "+";
  const digitsStart = escapeIndex + (extended ? 2 : 1);
  const digitsLength = extended ? 6 : 4;
  const digitsEnd = digitsStart + digitsLength;
  const rangeEnd = Math.min(digitsEnd, bodyEnd);
  return {
    next: digitsEnd,
    value: unicodeCodePoint(
      sql.slice(digitsStart, digitsEnd),
      escapeIndex,
      rangeEnd,
    ),
  };
};

const decodeUnicodeSegments = (
  sql: string,
  bodyRanges: ReadonlyArray<SqlSourceRange>,
  escapeCharacter: string,
  quote: "'" | "\"",
): ReadonlyArray<string> => {
  const values = bodyRanges.map(() => "");
  let pendingHigh: Readonly<{ range: SqlSourceRange; value: number }> | null = null;
  for (const [rangeIndex, bodyRange] of bodyRanges.entries()) {
    for (let index = bodyRange.start; index < bodyRange.end;) {
      if (sql[index] === quote && sql[index + 1] === quote) {
        if (pendingHigh !== null) {
          return lexerError(
            "invalid_unicode_surrogate",
            `High surrogate at offset ${String(pendingHigh.range.start)} is not followed by a low surrogate`,
            pendingHigh.range.start,
            pendingHigh.range.end,
          );
        }
        values[rangeIndex] += quote;
        index += 2;
        continue;
      }
      if (sql[index] !== escapeCharacter) {
        if (pendingHigh !== null) {
          return lexerError(
            "invalid_unicode_surrogate",
            `High surrogate at offset ${String(pendingHigh.range.start)} is not followed by a low surrogate`,
            pendingHigh.range.start,
            pendingHigh.range.end,
          );
        }
        const codePoint = readCodePoint(sql, index);
        if (codePoint === null) {
          break;
        }
        values[rangeIndex] += codePoint.character;
        index += codePoint.width;
        continue;
      }
      if (sql[index + 1] === escapeCharacter) {
        if (pendingHigh !== null) {
          return lexerError(
            "invalid_unicode_surrogate",
            `High surrogate at offset ${String(pendingHigh.range.start)} is not followed by a low surrogate`,
            pendingHigh.range.start,
            pendingHigh.range.end,
          );
        }
        values[rangeIndex] += escapeCharacter;
        index += 2;
        continue;
      }
      const first = readUnicodeEscapedCodePoint(
        sql,
        index,
        bodyRange.end,
      );
      const firstRange = { start: index, end: Math.min(first.next, bodyRange.end) };
      index = first.next;
      if (pendingHigh !== null) {
        if (first.value < 0xDC00 || first.value > 0xDFFF) {
          return lexerError(
            "invalid_unicode_surrogate",
            `Invalid Unicode surrogate pair at offset ${String(pendingHigh.range.start)}`,
            pendingHigh.range.start,
            firstRange.end,
          );
        }
        values[rangeIndex] += String.fromCodePoint(
          0x10000
            + ((pendingHigh.value - 0xD800) << 10)
            + first.value
            - 0xDC00,
        );
        pendingHigh = null;
      } else if (first.value >= 0xD800 && first.value <= 0xDBFF) {
        pendingHigh = { range: firstRange, value: first.value };
      } else if (first.value >= 0xDC00 && first.value <= 0xDFFF) {
        return lexerError(
          "invalid_unicode_surrogate",
          `Unexpected Unicode low surrogate at offset ${String(firstRange.start)}`,
          firstRange.start,
          firstRange.end,
        );
      } else {
        values[rangeIndex] += String.fromCodePoint(first.value);
      }
    }
  }
  if (pendingHigh !== null) {
    return lexerError(
      "invalid_unicode_surrogate",
      `High surrogate at offset ${String(pendingHigh.range.start)} is not followed by a low surrogate`,
      pendingHigh.range.start,
      pendingHigh.range.end,
    );
  }
  return values;
};

function readDollarTag(sql: string, start: number): string | null {
  if (sql[start] !== "$") {
    return null;
  }
  if (sql[start + 1] === "$") {
    return "$$";
  }
  const first = readCodePoint(sql, start + 1);
  if (first === null || !isIdentifierStart(first.character)) {
    return null;
  }
  let index = start + 1 + first.width;
  while (index < sql.length) {
    const current = readCodePoint(sql, index);
    if (
      current === null
      || !(isIdentifierStart(current.character) || /[0-9]/u.test(current.character))
    ) {
      break;
    }
    index += current.width;
  }
  return sql[index] === "$" ? sql.slice(start, index + 1) : null;
}

const validNumericToken = (
  sql: string,
  start: number,
  end: number,
  form: SqlValidNumericToken["form"],
): SqlValidNumericToken => {
  const text = sql.slice(start, end);
  return {
    kind: "numeric",
    form,
    normalized: text.replaceAll("_", "").toLowerCase(),
    range: { start, end },
    text,
    valid: true,
  };
};

const invalidNumericCode = (text: string): SqlInvalidNumericCode => {
  if (/__|_$|_\p{L}|_[.]|[.]_|_[eE]|[eE]_/u.test(text)) {
    return "invalid_separator";
  }
  if (/^0[xX](?:_)?$/u.test(text) || /^0[oObB](?:_)?$/u.test(text)) {
    return "missing_digits";
  }
  if (/[eE][+-]?(?:_)?$/u.test(text)) {
    return "invalid_exponent";
  }
  if (/^0[bB].*[2-9A-Za-z]/u.test(text)
    || /^0[oO].*[89A-Za-z]/u.test(text)
    || /^0[xX].*[G-Zg-z]/u.test(text)) {
    return "invalid_digit";
  }
  return "trailing_junk";
};

const invalidNumericToken = (
  sql: string,
  start: number,
  end: number,
): SqlInvalidNumericToken => {
  const text = sql.slice(start, end);
  const code = invalidNumericCode(text);
  return {
    diagnostic: {
      code,
      message: `Invalid PostgreSQL numeric literal ${JSON.stringify(text)}: ${code.replaceAll("_", " ")}`,
    },
    kind: "numeric",
    range: { start, end },
    text,
    valid: false,
  };
};

type NumericCandidate =
  | Readonly<{
    end: number;
    form: SqlValidNumericToken["form"];
    valid: true;
  }>
  | Readonly<{
    end: number;
    valid: false;
  }>;

const readSeparatedDigitsEnd = (
  sql: string,
  start: number,
  isDigit: (character: string) => boolean,
): number | null => {
  let index = start;
  if (!isDigit(sql[index] ?? "")) {
    return null;
  }
  index++;
  while (index < sql.length) {
    if (isDigit(sql[index] ?? "")) {
      index++;
    } else if (
      sql[index] === "_"
      && isDigit(sql[index + 1] ?? "")
    ) {
      index += 2;
    } else {
      break;
    }
  }
  return index;
};

const readDecimalDigitsEnd = (sql: string, start: number): number | null =>
  readSeparatedDigitsEnd(sql, start, (character) => /[0-9]/u.test(character));

const readRadixDigitsEnd = (
  sql: string,
  start: number,
  isDigit: (character: string) => boolean,
): number | null =>
  readSeparatedDigitsEnd(
    sql,
    sql[start] === "_" ? start + 1 : start,
    isDigit,
  );

const addNumericJunkCandidate = (
  candidates: Array<NumericCandidate>,
  sql: string,
  tokenEnd: number,
): void => {
  const next = readCodePoint(sql, tokenEnd);
  if (next !== null && isIdentifierStart(next.character)) {
    candidates.push({
      end: readIdentifierEnd(sql, tokenEnd),
      valid: false,
    });
  }
};

const longestNumericCandidate = (
  candidates: ReadonlyArray<NumericCandidate>,
): NumericCandidate => {
  const first = candidates[0];
  if (first === undefined) {
    throw new Error("Numeric scanning requires at least one candidate");
  }
  return candidates.reduce(
    (selected, candidate) =>
      candidate.end > selected.end ? candidate : selected,
    first,
  );
};

const scanNumeric = (
  sql: string,
  start: number,
): NumericScan => {
  const beginsWithDot = sql[start] === ".";
  const decimalIntegerEnd = beginsWithDot
    ? null
    : readDecimalDigitsEnd(sql, start);
  const candidates: Array<NumericCandidate> = [];
  if (decimalIntegerEnd !== null) {
    candidates.push({
      end: decimalIntegerEnd,
      form: "decimal",
      valid: true,
    });
  }

  const radix = !beginsWithDot && sql[start] === "0"
    ? sql[start + 1]?.toLowerCase()
    : undefined;
  if (radix === "x" || radix === "o" || radix === "b") {
    const digitPatterns = {
      b: /[01]/u,
      o: /[0-7]/u,
      x: /[0-9A-Fa-f]/u,
    } as const;
    const forms = {
      b: "binary",
      o: "octal",
      x: "hexadecimal",
    } as const;
    const radixEnd = readRadixDigitsEnd(
      sql,
      start + 2,
      (character) => digitPatterns[radix].test(character),
    );
    if (radixEnd !== null) {
      candidates.push({
        end: radixEnd,
        form: forms[radix],
        valid: true,
      });
    }
    candidates.push({
      end: start + 2 + (sql[start + 2] === "_" ? 1 : 0),
      valid: false,
    });
  }

  let numericEnd: number | null = null;
  if (beginsWithDot) {
    numericEnd = readDecimalDigitsEnd(sql, start + 1);
  } else if (
    decimalIntegerEnd !== null
    && sql[decimalIntegerEnd] === "."
    && sql[decimalIntegerEnd + 1] !== "."
  ) {
    numericEnd = readDecimalDigitsEnd(sql, decimalIntegerEnd + 1)
      ?? decimalIntegerEnd + 1;
  }
  if (numericEnd !== null) {
    candidates.push({ end: numericEnd, form: "decimal", valid: true });
  }

  const realEnds: Array<number> = [];
  for (const baseEnd of [decimalIntegerEnd, numericEnd]) {
    if (
      baseEnd === null
      || (sql[baseEnd] !== "e" && sql[baseEnd] !== "E")
    ) {
      continue;
    }
    const exponentStart = baseEnd
      + 1
      + (sql[baseEnd + 1] === "+" || sql[baseEnd + 1] === "-" ? 1 : 0);
    const realEnd = readDecimalDigitsEnd(sql, exponentStart);
    if (realEnd === null) {
      candidates.push({ end: exponentStart, valid: false });
    } else {
      candidates.push({ end: realEnd, form: "decimal", valid: true });
      realEnds.push(realEnd);
    }
  }

  if (decimalIntegerEnd !== null) {
    addNumericJunkCandidate(candidates, sql, decimalIntegerEnd);
  }
  if (numericEnd !== null) {
    addNumericJunkCandidate(candidates, sql, numericEnd);
  }
  for (const realEnd of realEnds) {
    addNumericJunkCandidate(candidates, sql, realEnd);
  }

  const selected = longestNumericCandidate(candidates);
  return {
    end: selected.end,
    token: selected.valid
      ? validNumericToken(sql, start, selected.end, selected.form)
      : invalidNumericToken(sql, start, selected.end),
  };
};

const adjustOperatorEnd = (
  sql: string,
  start: number,
  initialEnd: number,
): number => {
  let end = initialEnd;
  const nonStandard = /[~!@#%^&|`?]/u;
  while (
    end - start > 1
    && (sql[end - 1] === "+" || sql[end - 1] === "-")
    && !nonStandard.test(sql.slice(start, end))
  ) {
    end--;
  }
  return end;
};

const stringSegments = (
  segments: ReadonlyArray<QuotedSegment>,
  values: ReadonlyArray<string>,
  tokenRange: SqlSourceRange,
): ReadonlyArray<SqlStringSegment> => {
  if (values.length !== segments.length) {
    return lexerError(
      "internal_invariant",
      `Internal SQL policy lexer invariant failed: decoded ${String(values.length)} string segments for ${String(segments.length)} source segments`,
      tokenRange.start,
      tokenRange.end,
    );
  }
  return segments.map((segment, index) => {
    const value = values[index];
    if (value === undefined) {
      return lexerError(
        "internal_invariant",
        `Internal SQL policy lexer invariant failed: decoded string segment ${String(index)} is missing`,
        segment.range.start,
        segment.range.end,
      );
    }
    return {
      range: segment.range,
      value,
    };
  });
};

const hasSignificantToken = (
  tokens: ReadonlyArray<SqlPolicyToken>,
): boolean =>
  tokens.some((token) =>
    token.kind !== "comment" && token.kind !== "whitespace",
  );

const buildStatements = (
  sql: string,
  tokens: ReadonlyArray<SqlPolicyToken>,
): ReadonlyArray<SqlLexedStatement> => {
  const statements: Array<SqlLexedStatement> = [];
  let segmentStart = 0;
  let segmentTokens: Array<SqlPolicyToken> = [];
  const pushSegment = (
    end: number,
    terminatorRange: SqlSourceRange | null,
  ): void => {
    if (hasSignificantToken(segmentTokens)) {
      statements.push({
        range: { start: segmentStart, end },
        terminatorRange,
        tokens: segmentTokens,
      });
    }
    segmentStart = terminatorRange?.end ?? end;
    segmentTokens = [];
  };
  for (const token of tokens) {
    if (token.kind === "punctuation" && token.text === ";") {
      pushSegment(token.range.start, token.range);
    } else {
      segmentTokens.push(token);
    }
  }
  pushSegment(sql.length, null);
  return statements;
};

export const lexSqlPolicyInfrastructure = (sql: string): SqlLexedScript => {
  const invalidUnicodeIndex = invalidUtf16Index(sql);
  if (invalidUnicodeIndex !== -1) {
    return lexerError(
      "invalid_character",
      `Unpaired UTF-16 surrogate is not valid PostgreSQL UTF-8 input at offset ${String(invalidUnicodeIndex)}`,
      invalidUnicodeIndex,
      invalidUnicodeIndex + 1,
    );
  }
  const nulIndex = sql.indexOf("\0");
  if (nulIndex !== -1) {
    return lexerError(
      "invalid_character",
      `NUL is not allowed in PostgreSQL SQL text at offset ${String(nulIndex)}`,
      nulIndex,
      nulIndex + 1,
    );
  }
  const tokens: Array<SqlPolicyToken> = [];
  const pushSimpleToken = (
    kind: "operator" | "punctuation" | "whitespace",
    start: number,
    end: number,
  ): void => {
    tokens.push({ kind, range: { start, end }, text: sql.slice(start, end) });
  };

  for (let index = 0; index < sql.length;) {
    const start = index;
    const current = readCodePoint(sql, index);
    if (current === null) {
      break;
    }
    if (current.character === "\0") {
      return lexerError(
        "invalid_character",
        `NUL is not allowed in PostgreSQL SQL text at offset ${String(index)}`,
        index,
        index + 1,
      );
    }
    if (isSqlWhitespace(current.character)) {
      index += current.width;
      while (isSqlWhitespace(readCodePoint(sql, index)?.character ?? "")) {
        index += readCodePoint(sql, index)?.width ?? 0;
      }
      pushSimpleToken("whitespace", start, index);
      continue;
    }
    if (sql.startsWith("--", index)) {
      index += 2;
      while (
        index < sql.length
        && sql[index] !== "\n"
        && sql[index] !== "\r"
      ) {
        index += readCodePoint(sql, index)?.width ?? 1;
      }
      tokens.push({
        kind: "comment",
        range: { start, end: index },
        style: "line",
        text: sql.slice(start, index),
      });
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = readBlockCommentEnd(sql, index);
      tokens.push({
        kind: "comment",
        range: { start, end: index },
        style: "block",
        text: sql.slice(start, index),
      });
      continue;
    }

    const dollarTag = readDollarTag(sql, index);
    if (dollarTag !== null) {
      const closingStart = sql.indexOf(dollarTag, index + dollarTag.length);
      if (closingStart === -1) {
        return lexerError(
          "unterminated_dollar_string",
          `Unterminated dollar-quoted string ${dollarTag} starting at offset ${String(start)}`,
          start,
          sql.length,
        );
      }
      index = closingStart + dollarTag.length;
      const valueRange = {
        start: start + dollarTag.length,
        end: closingStart,
      };
      const semanticValue = sql.slice(valueRange.start, valueRange.end);
      tokens.push({
        dollarTag,
        kind: "string",
        range: { start, end: index },
        semanticSegments: [{ range: { start, end: index }, value: semanticValue }],
        semanticValue,
        style: "dollar",
        text: sql.slice(start, index),
        unicodeEscapeCharacter: null,
      });
      continue;
    }
    if (current.character === "$" && /[0-9]/u.test(sql[index + 1] ?? "")) {
      index++;
      while (/[0-9]/u.test(sql[index] ?? "")) {
        index++;
      }
      const positionEnd = index;
      const trailing = readCodePoint(sql, index);
      if (trailing !== null && isIdentifierStart(trailing.character)) {
        index = readIdentifierEnd(sql, index);
      }
      if (index !== positionEnd) {
        return lexerError(
          "invalid_parameter",
          `Trailing junk after positional parameter at offset ${String(start)}`,
          start,
          index,
        );
      }
      const positionText = sql.slice(start + 1, positionEnd);
      const positionValue = BigInt(positionText);
      if (positionValue > MAX_PARAMETER_NUMBER) {
        return lexerError(
          "parameter_number_too_large",
          `Positional parameter ${sql.slice(start, positionEnd)} at offset ${String(start)} exceeds PostgreSQL's maximum parameter number ${String(MAX_PARAMETER_NUMBER)}`,
          start,
          positionEnd,
        );
      }
      tokens.push({
        kind: "parameter",
        position: Number(positionValue),
        positionText,
        range: { start, end: index },
        text: sql.slice(start, index),
      });
      continue;
    }

    const prefix = sql.slice(index, index + 2).toLowerCase();
    if (prefix === "u&" && sql[index + 2] === "\"") {
      const quoted = readQuotedSegment(
        sql,
        index + 2,
        "\"",
        true,
        false,
        "unterminated_quoted_identifier",
      );
      const escapeClause = readUnicodeEscapeClause(sql, quoted.range.end);
      const decodedValues = decodeUnicodeSegments(
        sql,
        [quoted.bodyRange],
        escapeClause.escapeCharacter,
        "\"",
      );
      if (decodedValues.length !== 1) {
        return lexerError(
          "internal_invariant",
          `Internal SQL policy lexer invariant failed: decoded ${String(decodedValues.length)} Unicode identifier segments instead of 1`,
          start,
          quoted.range.end,
        );
      }
      const decoded = decodedValues[0];
      if (decoded === undefined) {
        return lexerError(
          "internal_invariant",
          "Internal SQL policy lexer invariant failed: decoded Unicode identifier segment is missing",
          start,
          quoted.range.end,
        );
      }
      if (decoded.length === 0) {
        return lexerError(
          "invalid_quoted_identifier",
          `PostgreSQL quoted identifiers cannot be empty at offset ${String(start)}`,
          start,
          quoted.range.end,
        );
      }
      const normalization = identifierNormalization(decoded, true);
      index = escapeClause.end;
      tokens.push({
        kind: "identifier",
        ...normalization,
        quoted: true,
        range: { start, end: index },
        text: sql.slice(start, index),
        unicodeEscapeCharacter: escapeClause.escapeCharacter,
        unicodeEscaped: true,
      });
      continue;
    }
    if (prefix === "u&" && sql[index + 2] === "'") {
      const sequence = readQuotedSequence(
        sql,
        start,
        index + 2,
        true,
        false,
      );
      const escapeClause = readUnicodeEscapeClause(sql, sequence.end);
      const values = decodeUnicodeSegments(
        sql,
        sequence.segments.map((segment) => segment.bodyRange),
        escapeClause.escapeCharacter,
        "'",
      );
      index = escapeClause.end;
      tokens.push({
        dollarTag: null,
        kind: "string",
        range: { start, end: index },
        semanticSegments: stringSegments(
          sequence.segments,
          values,
          { start, end: index },
        ),
        semanticValue: values.join(""),
        style: "unicode",
        text: sql.slice(start, index),
        unicodeEscapeCharacter: escapeClause.escapeCharacter,
      });
      continue;
    }
    const singlePrefix = sql[index]?.toLowerCase();
    if (
      (singlePrefix === "b"
        || singlePrefix === "e"
        || singlePrefix === "n"
        || singlePrefix === "x")
      && sql[index + 1] === "'"
    ) {
      const sequence = readQuotedSequence(
        sql,
        start,
        index + 1,
        singlePrefix !== "b" && singlePrefix !== "x",
        singlePrefix === "e",
      );
      const styles = {
        b: "bit",
        e: "escape",
        n: "national",
        x: "hex",
      } as const;
      const values = singlePrefix === "e"
        ? decodeEscapeSegments(sql, sequence.segments)
        : sequence.segments.map((segment) =>
          singlePrefix === "n"
            ? decodeDoubledQuotes(sql, segment.bodyRange, "'")
            : sql.slice(segment.bodyRange.start, segment.bodyRange.end),
        );
      index = sequence.end;
      tokens.push({
        dollarTag: null,
        kind: "string",
        range: { start, end: index },
        semanticSegments: stringSegments(
          sequence.segments,
          values,
          { start, end: index },
        ),
        semanticValue: values.join(""),
        style: styles[singlePrefix],
        text: sql.slice(start, index),
        unicodeEscapeCharacter: null,
      });
      continue;
    }
    if (current.character === "'") {
      const sequence = readQuotedSequence(
        sql,
        start,
        index,
        true,
        false,
      );
      const values = sequence.segments.map((segment) =>
        decodeDoubledQuotes(sql, segment.bodyRange, "'"),
      );
      index = sequence.end;
      tokens.push({
        dollarTag: null,
        kind: "string",
        range: { start, end: index },
        semanticSegments: stringSegments(
          sequence.segments,
          values,
          { start, end: index },
        ),
        semanticValue: values.join(""),
        style: "ordinary",
        text: sql.slice(start, index),
        unicodeEscapeCharacter: null,
      });
      continue;
    }
    if (current.character === "\"") {
      const quoted = readQuotedSegment(
        sql,
        index,
        "\"",
        true,
        false,
        "unterminated_quoted_identifier",
      );
      index = quoted.range.end;
      const text = sql.slice(start, index);
      const decoded = decodeDoubledQuotes(sql, quoted.bodyRange, "\"");
      if (decoded.length === 0) {
        return lexerError(
          "invalid_quoted_identifier",
          `PostgreSQL quoted identifiers cannot be empty at offset ${String(start)}`,
          start,
          index,
        );
      }
      const normalization = identifierNormalization(decoded, true);
      tokens.push({
        kind: "identifier",
        ...normalization,
        quoted: true,
        range: { start, end: index },
        text,
        unicodeEscapeCharacter: null,
        unicodeEscaped: false,
      });
      continue;
    }
    if (
      /[0-9]/u.test(current.character)
      || (
        current.character === "."
        && /[0-9]/u.test(sql[index + 1] ?? "")
      )
    ) {
      const numeric = scanNumeric(sql, index);
      tokens.push(numeric.token);
      index = numeric.end;
      continue;
    }
    if (isIdentifierStart(current.character)) {
      index = readIdentifierEnd(sql, index);
      const text = sql.slice(start, index);
      const normalization = identifierNormalization(text, false);
      tokens.push({
        kind: "identifier",
        ...normalization,
        quoted: false,
        range: { start, end: index },
        text,
        unicodeEscapeCharacter: null,
        unicodeEscaped: false,
      });
      continue;
    }
    if (sql.startsWith("::", index) || sql.startsWith(":=", index)) {
      index += 2;
      pushSimpleToken("operator", start, index);
      continue;
    }
    if (sql.startsWith("..", index)) {
      index += 2;
      pushSimpleToken("operator", start, index);
      continue;
    }
    if (OPERATOR_CHARACTERS.has(current.character)) {
      index += current.width;
      while (
        OPERATOR_CHARACTERS.has(
          readCodePoint(sql, index)?.character ?? "",
        )
        && !sql.startsWith("--", index)
        && !sql.startsWith("/*", index)
      ) {
        index += readCodePoint(sql, index)?.width ?? 0;
      }
      index = adjustOperatorEnd(sql, start, index);
      if (Buffer.byteLength(sql.slice(start, index), "utf8") > MAX_IDENTIFIER_BYTES) {
        return lexerError(
          "operator_too_long",
          `PostgreSQL operator at offset ${String(start)} exceeds ${String(MAX_IDENTIFIER_BYTES)} bytes`,
          start,
          index,
        );
      }
      pushSimpleToken("operator", start, index);
      continue;
    }
    if (
      PUNCTUATION_CHARACTERS.has(current.character)
      || current.character === "."
      || current.character === ":"
      || current.character === "$"
    ) {
      index += current.width;
      pushSimpleToken("punctuation", start, index);
      continue;
    }
    index += current.width;
    pushSimpleToken("punctuation", start, index);
  }

  return {
    sql,
    statements: buildStatements(sql, tokens),
    tokens,
  };
};
