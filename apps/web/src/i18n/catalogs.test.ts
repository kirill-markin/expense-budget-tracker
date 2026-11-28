import assert from "node:assert/strict";
import test from "node:test";

import { SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/locale";

import { initI18n, type TranslationBundle } from "./i18nConfig";
import { getMessages, t, ti } from "./serverT";

const PLURAL_KEY = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/;
const COUNT_PLACEHOLDER = "{{count}}";

// List the exact plural form when its wording already expresses the count.
const omittedCountKeys: Readonly<Partial<Record<SupportedLocale, ReadonlyArray<string>>>> = {};

const englishMessages = getMessages("en");

const expectedMessages = (locale: SupportedLocale, messages: TranslationBundle): ReadonlyMap<string, string> => {
  const cardinalCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const ordinalCategories = new Intl.PluralRules(locale, { type: "ordinal" }).resolvedOptions().pluralCategories;
  const expected = new Map<string, string>();

  for (const [key, message] of Object.entries(englishMessages)) {
    const plural = PLURAL_KEY.exec(key);
    if (plural === null) {
      expected.set(key, message);
      continue;
    }

    const [, base, ordinalSuffix, category] = plural;
    if (category !== "other") continue;

    const isOrdinal = ordinalSuffix !== undefined;
    const stem = isOrdinal ? `${base}_ordinal` : base;
    for (const suffix of isOrdinal ? ordinalCategories : cardinalCategories) {
      expected.set(`${stem}_${suffix}`, message);
    }

    // i18next also supports an exact zero override independently of Intl.PluralRules.
    const zeroKey = `${stem}_zero`;
    if (!isOrdinal && Object.hasOwn(messages, zeroKey)) expected.set(zeroKey, message);
  }

  return expected;
};

const placeholderTokens = (message: string): string[] =>
  (message.match(/{{[\s\S]*?}}/g) ?? []).sort();

const assertPlaceholders = (
  locale: SupportedLocale,
  key: string,
  message: string,
  expected: ReadonlyArray<string>,
): void => {
  assert.deepEqual(placeholderTokens(message), expected, `${locale}:${key} placeholder mismatch`);
};

for (const locale of SUPPORTED_LOCALES) {
  test(`${locale} catalog has the required keys and interpolation placeholders`, (): void => {
    const messages = getMessages(locale);
    const expected = expectedMessages(locale, messages);
    const omissions = omittedCountKeys[locale] ?? [];

    const missing = Array.from(expected.keys()).filter((key) => !Object.hasOwn(messages, key));
    const extra = Object.keys(messages).filter((key) => !expected.has(key));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${locale} catalog key mismatch`);

    for (const key of omissions) {
      const message = expected.get(key);
      assert.ok(PLURAL_KEY.test(key) && message !== undefined && placeholderTokens(message).includes(COUNT_PLACEHOLDER),
        `${locale}:${key} count omission requires a plural form with a count placeholder`);
    }

    for (const [key, message] of expected) {
      const sourcePlaceholders = placeholderTokens(message);
      const expectedPlaceholders = omissions.includes(key)
        ? sourcePlaceholders.filter((token) => token !== COUNT_PLACEHOLDER)
        : sourcePlaceholders;
      assertPlaceholders(locale, key, messages[key], expectedPlaceholders);
    }
  });
}

test("server-interpolated placeholders reject extra whitespace", (): void => {
  const key = "chat.demoRateLimitReached";
  assert.throws(
    () => assertPlaceholders("es", key, "{{ limit }}", placeholderTokens(englishMessages[key])),
    { code: "ERR_ASSERTION", message: /es:chat\.demoRateLimitReached placeholder mismatch/ },
  );
});

for (const token of ["{{ - count }}", "{{\ncount}}", "{{ count }}", "{{- count }}"]) {
  test(`catalog placeholders reject ${JSON.stringify(token)} when English uses {{count}}`, (): void => {
    const key = "common.unpairedTransferMore";
    assert.throws(
      () => assertPlaceholders("es", key, token, placeholderTokens(englishMessages[key])),
      { code: "ERR_ASSERTION", message: /es:common\.unpairedTransferMore placeholder mismatch/ },
    );
  });
}

test("a multiline count token is still detected when count is omitted", (): void => {
  assert.throws(
    () => assertPlaceholders("he", "example_two", "{{\ncount}}", []),
    { code: "ERR_ASSERTION", message: /he:example_two placeholder mismatch/ },
  );
});

test("i18next initializes synchronously with only the requested locale", (): void => {
  const spanish = initI18n("es", getMessages("es"));
  const hebrew = initI18n("he", getMessages("he"));

  assert.ok(spanish.isInitialized && hebrew.isInitialized);
  assert.deepEqual(Object.keys(spanish.store.data), ["es"]);
  assert.deepEqual(Object.keys(hebrew.store.data), ["he"]);
  assert.equal(spanish.t("nav.settings"), t("es", "nav.settings"));
  assert.equal(hebrew.t("nav.settings"), t("he", "nav.settings"));
  assert.equal(spanish.t("common.unpairedTransferMore", { count: 3 }),
    ti("es", "common.unpairedTransferMore", { count: 3 }));
});
