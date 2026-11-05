/**
 * Locale-independent translation core shared by the plugin host and the
 * browser bundle. This module must stay free of Node.js imports.
 */
import { en, type MessageKey } from './en.js';
import { ru } from './ru.js';
import { zhCN } from './zh-CN.js';
import { format, placeholders } from './format.js';
import {
  FALLBACK_LOCALE,
  LOCALE_LABELS,
  LOCALES,
  isLocale,
  normalizeLocale,
  type Locale,
  type MessageParams,
} from './types.js';

export { format, placeholders } from './format.js';
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
