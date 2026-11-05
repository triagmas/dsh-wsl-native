import { en, type MessageKey } from './en.js';
import { ru } from './ru.js';
import { zhCN } from './zh-CN.js';
import {
  FALLBACK_LOCALE,
  LOCALE_LABELS,
  LOCALES,
  isLocale,
  normalizeLocale,
  type Locale,
  type MessageParams,
} from './types.js';

export { en, ru, zhCN };
export type { MessageKey };
export { FALLBACK_LOCALE, LOCALE_LABELS, LOCALES, isLocale, normalizeLocale };
export type { Locale, MessageParams };

/** All dictionaries keyed by locale. Every locale carries the complete key set. */
export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = Object.freeze({
  en,
  ru,
  'zh-CN': zhCN,
});

const PLACEHOLDER = /\{(\w+)\}/g;

/** Names of the interpolation placeholders used by one template. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string).sort();
}

/** Replace `{name}` placeholders; unknown placeholders stay verbatim on purpose. */
export function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Read-only translator handle bound to one locale. */
export interface Translator {
  readonly locale: Locale;
  t(key: MessageKey, params?: MessageParams): string;
}

/**
 * Build a translator for one locale. Lookup order is the locale itself, then
 * English; a key missing from both dictionaries (only possible for an
 * untyped call) is returned verbatim so the gap is visible in the UI.
 */
export function createTranslator(locale: Locale): Translator {
  const active = DICTIONARIES[locale] ?? DICTIONARIES[FALLBACK_LOCALE];
  const fallback = DICTIONARIES[FALLBACK_LOCALE];
  return {
    locale,
    t(key, params) {
      const template = active[key] ?? fallback[key];
      return template === undefined ? key : format(template, params);
    },
  };
}

const LANGUAGE_ENV_ORDER = ['DSH_WSL_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG'] as const;

/** Environment variables consulted for automatic language detection. */
export type LocaleEnv = Readonly<Record<string, string | undefined>>;

/**
 * First language tag found in the environment. `LANGUAGE` is a colon-separated
 * priority list, so it is split before normalization.
 */
function fromEnvironment(env: LocaleEnv): Locale | null {
  for (const name of LANGUAGE_ENV_ORDER) {
    const raw = env[name];
    if (!raw) continue;
    for (const candidate of raw.split(':')) {
      const locale = normalizeLocale(candidate.split('.')[0]?.split('@')[0]);
      if (locale) return locale;
    }
  }
  return null;
}

/** Map the host system locale reported by ICU (`ru-RU`, `zh-Hans-CN`, ...). */
function fromIntl(): Locale | null {
  try {
    return normalizeLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

/** Automatic detection used when the user has not chosen a language. */
export function detectLocale(env: LocaleEnv = process.env, intl: () => Locale | null = fromIntl): Locale {
  return fromEnvironment(env) ?? intl() ?? FALLBACK_LOCALE;
}

/** An explicit, supported preference always wins over detection. */
export function resolveLocale(preference: unknown, detected: Locale): Locale {
  return normalizeLocale(preference) ?? detected;
}

/** Module-level translator used by error constructors and tool descriptions. */
let active: Translator = createTranslator(FALLBACK_LOCALE);

/** Current process locale for messages produced outside a translated call site. */
export function getLocale(): Locale {
  return active.locale;
}

/** Switch the process locale; the plugin calls this on load and on preference change. */
export function setLocale(locale: Locale | string): Locale {
  const resolved = isLocale(locale) ? locale : (normalizeLocale(locale) ?? FALLBACK_LOCALE);
  active = createTranslator(resolved);
  return resolved;
}

/** Translate with the process locale. */
export function t(key: MessageKey, params?: MessageParams): string {
  return active.t(key, params);
}

/** Translate with an explicit locale, independent of the process locale. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return createTranslator(locale).t(key, params);
}

/**
 * Keys whose English template is missing from `locale`, or whose placeholder
 * set differs from English. Used by the CI check and by `status`.
 */
export function missingTranslations(locale: Locale): string[] {
  if (locale === FALLBACK_LOCALE) return [];
  const dictionary = DICTIONARIES[locale] as Readonly<Record<string, string>> | undefined;
  if (!dictionary) return Object.keys(en);
  const problems: string[] = [];
  for (const key of Object.keys(en) as MessageKey[]) {
    const value = dictionary[key];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key}: missing`);
      continue;
    }
    const expected = placeholders(en[key]);
    const actual = placeholders(value);
    if (expected.join(',') !== actual.join(',')) {
      problems.push(`${key}: placeholders ${actual.join(',') || '(none)'} != ${expected.join(',') || '(none)'}`);
    }
  }
  return problems;
}
