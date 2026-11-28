import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocaleMatcher,
  LOCALE_REGISTRY,
  matchAcceptLanguage,
  normalizeLocaleTag,
  parseSupportedLocale,
  SUPPORTED_LOCALES,
} from "./locales.js";

const regionalRegistry = {
  ...LOCALE_REGISTRY,
  "es-419": { tag: "es-419", label: "Español latinoamericano", direction: "ltr" },
  "es-MX": { tag: "es-MX", label: "Español de México", direction: "ltr" },
  "zh-Hant": { tag: "zh-Hant", label: "繁體中文", direction: "ltr" },
  "zh-Hant-HK": { tag: "zh-Hant-HK", label: "香港繁體中文", direction: "ltr" },
} as const;

test("explicit preferences accept registered IDs and canonical tags", (): void => {
  assert.equal(normalizeLocaleTag("zH-hAnT-hK"), "zh-Hant-HK");
  assert.equal(normalizeLocaleTag("iw-IL"), "he-IL");
  assert.equal(normalizeLocaleTag("es_MX"), null);
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(parseSupportedLocale(locale), locale);
  }
  assert.equal(parseSupportedLocale("ZH-hans"), "zh");
  assert.equal(parseSupportedLocale("zh-Hant"), null);
  assert.equal(parseSupportedLocale("es-MX"), null);
  assert.equal(parseSupportedLocale("es-u-nu-latn"), null);
  assert.equal(createLocaleMatcher(regionalRegistry, "en").parseSupportedLocale("es-mx"), "es-MX");
});

test("browser negotiation prefers exact registered variants before less specific tags", (): void => {
  const { matchAcceptLanguage } = createLocaleMatcher(regionalRegistry, "en");
  assert.equal(matchAcceptLanguage("es-mx"), "es-MX");
  assert.equal(matchAcceptLanguage("es-419"), "es-419");
  assert.equal(matchAcceptLanguage("es-Latn-MX"), "es-MX");
  assert.equal(matchAcceptLanguage("es-AR-u-nu-latn"), "es");
  assert.equal(matchAcceptLanguage("zh-hant-hk"), "zh-Hant-HK");
  assert.equal(matchAcceptLanguage("zh-HK"), "zh-Hant-HK");
  assert.equal(matchAcceptLanguage("zh-hant-CN"), "zh-Hant");
  assert.equal(matchAcceptLanguage("zh-hans-TW"), "zh");

  const exactRegionRegistry = {
    ...regionalRegistry,
    "zh-HK": { tag: "zh-HK", label: "香港中文", direction: "ltr" },
  } as const;
  assert.equal(createLocaleMatcher(exactRegionRegistry, "en").matchAcceptLanguage("zh-HK"), "zh-HK");
});

test("browser negotiation maps Chinese regions to their scripts", (): void => {
  const { matchAcceptLanguage: matchWithTraditionalChinese } = createLocaleMatcher(regionalRegistry, "en");
  for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans"]) {
    assert.equal(matchWithTraditionalChinese(tag), "zh");
  }
  for (const tag of ["zh-TW", "zh-MO", "zh-Hant"]) {
    assert.equal(matchWithTraditionalChinese(tag), "zh-Hant");
    assert.equal(matchAcceptLanguage(tag), "zh");
  }
  assert.equal(matchAcceptLanguage("zh-HK"), "zh");
});

test("browser negotiation matches an inferred script and region without a generic script choice", (): void => {
  const hongKongRegistry = {
    ...LOCALE_REGISTRY,
    "zh-Hant-HK": regionalRegistry["zh-Hant-HK"],
  } as const;
  assert.equal(createLocaleMatcher(hongKongRegistry, "en").matchAcceptLanguage("zh-HK"), "zh-Hant-HK");
});

test("browser negotiation respects valid weights and keeps header order on ties", (): void => {
  assert.equal(matchAcceptLanguage("es;q=0.8, iw-IL; Q=0.95, ar;q=0.7"), "he");
  assert.equal(matchAcceptLanguage("ru;q=0.8, es;q=0.8"), "ru");
  assert.equal(matchAcceptLanguage("ru;q=0, zh;q=0.000, ar"), "ar");
  assert.equal(matchAcceptLanguage("fr-CA, es;q=0.2"), "es");
  assert.equal(matchAcceptLanguage("*, es;q=0.2"), "es");
});

test("browser negotiation skips malformed entries and defaults after named preferences", (): void => {
  const malformedRanges = ["es_MX", "es--MX", "es;q=no", "es;q=1.1", "es;q=0.9999", "es;q=.9", "es;q=0.9x", "es;q=0.9;other=yes"];
  assert.equal(matchAcceptLanguage([...malformedRanges, "ru;q=0.1"].join(", ")), "ru");
  for (const header of [null, undefined, "", "no-NO, es;q=0, *", ...malformedRanges]) {
    assert.equal(matchAcceptLanguage(header), "en");
  }
});
