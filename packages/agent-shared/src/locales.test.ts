import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACT_LOCALE_PICKER_LIMIT,
  createLocaleMatcher,
  createLocalePickerOptions,
  LOCALE_REGISTRY,
  matchAcceptLanguage,
  normalizeLocaleSearch,
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

test("the eight current locale options retain their native labels and order", (): void => {
  const options = createLocalePickerOptions(SUPPORTED_LOCALES, LOCALE_REGISTRY);
  assert.equal(options.length, COMPACT_LOCALE_PICKER_LIMIT);
  assert.deepEqual(options.map(({ id }) => id), SUPPORTED_LOCALES);
  assert.deepEqual(options.map(({ label }) => label), SUPPORTED_LOCALES.map((id) => LOCALE_REGISTRY[id].label));
});

test("a longer picker distinguishes script and region variants and searches names and tags", (): void => {
  const ids = Object.keys(regionalRegistry) as Array<keyof typeof regionalRegistry>;
  const options = createLocalePickerOptions(ids, regionalRegistry);
  const search = (value: string): ReadonlyArray<string> =>
    options.filter(({ searchText }) => searchText.includes(normalizeLocaleSearch(value))).map(({ id }) => id);

  assert.ok(options.length > COMPACT_LOCALE_PICKER_LIMIT);
  assert.equal(options.find(({ id }) => id === "zh")?.label, "中文 (zh-Hans)");
  assert.equal(options.find(({ id }) => id === "zh-Hant")?.label, "繁體中文 (zh-Hant)");
  assert.equal(options.find(({ id }) => id === "es-MX")?.label, "Español de México (es-MX)");
  assert.deepEqual(search("  MEXICAN SPANISH  "), ["es-MX"]);
  assert.deepEqual(search("Español latinoamericano"), ["es-419"]);
  assert.deepEqual(search("العربية"), ["ar"]);
  assert.deepEqual(search("Simplified Chinese"), ["zh"]);
  assert.deepEqual(search("ＺＨ－ＨＡＮＴ－ＨＫ"), ["zh-Hant-HK"]);
  assert.deepEqual(search("no such language"), []);
});
