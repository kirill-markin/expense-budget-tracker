export type AccountMentionSuggestion = Readonly<{
  accountId: string;
  currency: string;
}>;

export type AccountMentionTrigger = Readonly<{
  start: number;
  end: number;
  query: string;
  isQuoted: boolean;
}>;

export type AccountMentionReplacement = Readonly<{
  text: string;
  caretPosition: number;
}>;

const SAFE_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_ACCOUNT_ID_CHARACTER_PATTERN = /^[A-Za-z0-9_-]$/;
const JSON_ESCAPE_VALUES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const isSafeAccountIdCharacter = (value: string): boolean =>
  SAFE_ACCOUNT_ID_CHARACTER_PATTERN.test(value);

const isMentionStart = (text: string, index: number): boolean =>
  text[index] === "@" && (index === 0 || /\s/u.test(text[index - 1]));

const decodeQuotedQuery = (value: string): string | null => {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20) {
        return null;
      }
      decoded += character;
      continue;
    }

    const escapeCharacter = value[index + 1];
    if (escapeCharacter === undefined) {
      return decoded;
    }

    if (escapeCharacter === "u") {
      const codePoint = value.slice(index + 2, index + 6);
      if (codePoint.length < 4) {
        return decoded;
      }
      if (!/^[0-9A-Fa-f]{4}$/.test(codePoint)) {
        return null;
      }
      decoded += String.fromCharCode(Number.parseInt(codePoint, 16));
      index += 5;
      continue;
    }

    const escapedValue = JSON_ESCAPE_VALUES[escapeCharacter];
    if (escapedValue === undefined) {
      return null;
    }
    decoded += escapedValue;
    index += 1;
  }

  return decoded;
};

const findQuotedFragmentEnd = (
  text: string,
  contentStart: number,
): Readonly<{ end: number; hasClosingQuote: boolean }> => {
  let isEscaped = false;

  for (let index = contentStart; index < text.length; index += 1) {
    const character = text[index];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (character === "\\") {
      isEscaped = true;
      continue;
    }
    if (character === '"') {
      return { end: index + 1, hasClosingQuote: true };
    }
    if (character.charCodeAt(0) < 0x20) {
      return { end: index, hasClosingQuote: false };
    }
  }

  return { end: text.length, hasClosingQuote: false };
};

export const findAccountMentionTrigger = (
  text: string,
  caretPosition: number,
): AccountMentionTrigger | null => {
  if (!Number.isInteger(caretPosition) || caretPosition < 0 || caretPosition > text.length) {
    throw new RangeError(
      `Account mention caret position ${caretPosition} is outside text length ${text.length}`,
    );
  }

  for (let start = 0; start < text.length; start += 1) {
    if (!isMentionStart(text, start)) {
      continue;
    }

    const isQuoted = text[start + 1] === '"';
    if (isQuoted) {
      const contentStart = start + 2;
      const fragment = findQuotedFragmentEnd(text, contentStart);
      const end = fragment.end;
      const closingQuoteIndex = fragment.hasClosingQuote ? end - 1 : end;
      if (caretPosition >= contentStart && caretPosition <= closingQuoteIndex) {
        const query = decodeQuotedQuery(text.slice(contentStart, caretPosition));
        if (query === null) {
          return null;
        }
        return { start, end, query, isQuoted: true };
      }

      if (caretPosition < start || caretPosition < contentStart) {
        return null;
      }
      if (!fragment.hasClosingQuote) {
        if (end === text.length) {
          return null;
        }
        start = end;
        continue;
      }
      start = end - 1;
      continue;
    }

    const contentStart = start + 1;
    let end = contentStart;
    while (end < text.length && isSafeAccountIdCharacter(text[end])) {
      end += 1;
    }
    if (caretPosition >= contentStart && caretPosition <= end) {
      return {
        start,
        end,
        query: text.slice(contentStart, caretPosition),
        isQuoted: false,
      };
    }
    if (caretPosition < start) {
      return null;
    }
    if (end > start) {
      start = end - 1;
    }
  }

  return null;
};

export const rankAccountSuggestions = (
  suggestions: ReadonlyArray<AccountMentionSuggestion>,
  query: string,
): ReadonlyArray<AccountMentionSuggestion> => {
  const normalizedQuery = query.toLowerCase();
  if (normalizedQuery.length === 0) {
    return suggestions;
  }

  const prefixMatches: Array<AccountMentionSuggestion> = [];
  const substringMatches: Array<AccountMentionSuggestion> = [];
  for (const suggestion of suggestions) {
    const normalizedAccountId = suggestion.accountId.toLowerCase();
    if (normalizedAccountId.startsWith(normalizedQuery)) {
      prefixMatches.push(suggestion);
    } else if (normalizedAccountId.includes(normalizedQuery)) {
      substringMatches.push(suggestion);
    }
  }

  return [...prefixMatches, ...substringMatches];
};

export const formatAccountMention = (accountId: string): string => {
  if (accountId.length === 0) {
    throw new Error("Cannot format an account mention for an empty account ID");
  }

  return SAFE_ACCOUNT_ID_PATTERN.test(accountId)
    ? `@${accountId}`
    : `@${JSON.stringify(accountId)}`;
};

export const replaceAccountMention = (
  text: string,
  trigger: AccountMentionTrigger,
  accountId: string,
): AccountMentionReplacement => {
  if (
    trigger.start < 0
    || trigger.end < trigger.start
    || trigger.end > text.length
    || text[trigger.start] !== "@"
  ) {
    throw new RangeError(
      `Invalid account mention range ${trigger.start}:${trigger.end} for text length ${text.length}`,
    );
  }

  const formattedMention = formatAccountMention(accountId);
  const suffix = text.slice(trigger.end);
  const needsTrailingSpace = suffix.length === 0
    || isSafeAccountIdCharacter(suffix[0]);
  const insertion = needsTrailingSpace ? `${formattedMention} ` : formattedMention;

  return {
    text: `${text.slice(0, trigger.start)}${insertion}${suffix}`,
    caretPosition: trigger.start + insertion.length,
  };
};
