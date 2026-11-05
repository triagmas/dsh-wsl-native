/**
 * Locale identifiers supported by this plugin.
 * `zh-CN` keeps compatibility with the upstream project; `en` is the fallback
 * consulted whenever a key is missing from the active language.
 */
export const LOCALES = ['en', 'ru', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

/** Fallback language for every dictionary lookup and every unknown input. */
export const FALLBACK_LOCALE: Locale = 'en';

/** Interpolation values accepted by a translated message. */
export type MessageParams = Record<string, string | number | boolean>;

/**
 * One dictionary shape: every supported locale must provide exactly the same
 * keys, which the compiler enforces through `Record<MessageKey, string>`.
 */
export type Dictionary<K extends string = string> = Readonly<Record<K, string>>;

/** Language labels rendered by the in-app language selector. */
export const LOCALE_LABELS: Readonly<Record<Locale, string>> = Object.freeze({
  en: 'English',
  ru: 'Русский',
  'zh-CN': '中文',
});

/** Accepts BCP 47-style ids and narrows them to a supported locale. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Normalize a user or environment supplied language tag to a supported locale.
 * Regional variants map onto their base language (`ru-RU` -> `ru`,
 * `zh-Hans-CN` -> `zh-CN`); anything unknown reports `null`, not the fallback,
 * so callers can keep searching preference sources.
 */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().replace(/_/g, '-').toLowerCase();
  if (!tag || tag.length > 64) return null;
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  if (tag === 'ru' || tag.startsWith('ru-')) return 'ru';
  if (tag === 'zh' || tag.startsWith('zh-') || tag === 'zh-cn') return 'zh-CN';
  return null;
}
