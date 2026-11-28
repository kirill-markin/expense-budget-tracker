export type LocaleMetadata = Readonly<{
  tag: string;
  label: string;
  direction: "ltr" | "rtl";
}>;

export const LOCALE_REGISTRY = {
  en: { tag: "en", label: "English", direction: "ltr" },
  ru: { tag: "ru", label: "Русский", direction: "ltr" },
  es: { tag: "es", label: "Español", direction: "ltr" },
  uk: { tag: "uk", label: "Українська", direction: "ltr" },
  fa: { tag: "fa", label: "فارسی", direction: "rtl" },
  zh: { tag: "zh-Hans", label: "中文", direction: "ltr" },
  ar: { tag: "ar", label: "العربية", direction: "rtl" },
  he: { tag: "he", label: "עברית", direction: "rtl" },
} as const satisfies Readonly<Record<string, LocaleMetadata>>;

export type SupportedLocale = keyof typeof LOCALE_REGISTRY;

export const SUPPORTED_LOCALES: ReadonlyArray<SupportedLocale> = Object.keys(LOCALE_REGISTRY) as SupportedLocale[];
export const DEFAULT_LOCALE = "en" satisfies SupportedLocale;
export const APP_LOCALE_COOKIE = "app_locale";
export const AUTH_LOCALE_COOKIE = "auth_locale";
export const CARRY_LOCALE_QUERY_PARAM = "carry_locale";

const parseLocaleTag = (raw: string | null | undefined): Intl.Locale | null => {
  if (raw == null) return null;
  try {
    return new Intl.Locale(raw);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
};

export const normalizeLocaleTag = (raw: string | null | undefined): string | null =>
  parseLocaleTag(raw)?.toString() ?? null;

const traditionalChineseRegions: ReadonlySet<string> = new Set(["TW", "HK", "MO"]);

// Wildcards leave the choice to the default after named preferences are exhausted.
const languageRangePattern = /^[ \t]*([a-z][a-z0-9-]*)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?[ \t]*$/iu;

type LocaleMatcher<Locale extends string> = Readonly<{
  parseSupportedLocale: (raw: string | null | undefined) => Locale | null;
  matchAcceptLanguage: (header: string | null | undefined) => Locale;
}>;

export const createLocaleMatcher = <Locale extends string>(
  registry: Readonly<Record<Locale, LocaleMetadata>>,
  defaultLocale: NoInfer<Locale>,
): LocaleMatcher<Locale> => {
  const byId = new Map<string, Locale>();
  const byTag = new Map<string, Locale>();
  for (const id of Object.keys(registry) as Locale[]) {
    byId.set(id, id);
    byTag.set(registry[id].tag, id);
  }
  const findExact = (tag: string): Locale | undefined => byTag.get(tag) ?? byId.get(tag);

  const parseSupportedLocale = (raw: string | null | undefined): Locale | null => {
    const tag = normalizeLocaleTag(raw);
    return tag === null ? null : findExact(tag) ?? null;
  };

  const matchBrowserLocale = (preferred: Intl.Locale): Locale | undefined => {
    const { language, region } = preferred;
    const exact = findExact(preferred.toString()) ?? findExact(preferred.baseName);
    if (exact !== undefined) return exact;

    const script = preferred.script ?? (language === "zh"
      ? region !== undefined && traditionalChineseRegions.has(region) ? "Hant" : "Hans"
      : undefined);

    const scriptRegionMatch = script === undefined || region === undefined
      ? undefined
      : findExact(`${language}-${script}-${region}`);
    const scriptMatch = script === undefined ? undefined : findExact(`${language}-${script}`);
    const regionMatch = region === undefined ? undefined : findExact(`${language}-${region}`);
    return scriptRegionMatch ?? scriptMatch ?? regionMatch ?? findExact(language);
  };

  const matchAcceptLanguage = (header: string | null | undefined): Locale => {
    if (header == null) return defaultLocale;

    const preferences: Array<{ locale: Intl.Locale; quality: number }> = [];
    for (const range of header.split(",")) {
      const match = languageRangePattern.exec(range);
      if (match === null) continue;
      const quality = match[2] === undefined ? 1 : Number(match[2]);
      if (quality === 0) continue;
      const locale = parseLocaleTag(match[1]);
      if (locale !== null) preferences.push({ locale, quality });
    }

    preferences.sort((a, b) => b.quality - a.quality);
    for (const { locale } of preferences) {
      const match = matchBrowserLocale(locale);
      if (match !== undefined) return match;
    }
    return defaultLocale;
  };

  return { parseSupportedLocale, matchAcceptLanguage };
};

export const { parseSupportedLocale, matchAcceptLanguage } = createLocaleMatcher(LOCALE_REGISTRY, DEFAULT_LOCALE);
