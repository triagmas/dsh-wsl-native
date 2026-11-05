/**
 * Browser-side translation handle. The locale comes from the plugin status
 * response, so the panel follows the same persisted preference as the host and
 * falls back to English when a key is missing.
 */
import { CLIENT_DICTIONARIES } from './client-strings.js';
import { format } from './format.js';
import { normalizeLocale } from './types.js';
import { FALLBACK_LOCALE, type Locale, type MessageParams } from './types.js';
import type { MessageKey } from './en.js';
import type { Translator } from './core.js';

/** Translator backed by the browser-sized dictionary slice. */
function createClientTranslator(locale: Locale): Translator {
  const active = CLIENT_DICTIONARIES[locale] ?? CLIENT_DICTIONARIES[FALLBACK_LOCALE];
  const fallback = CLIENT_DICTIONARIES[FALLBACK_LOCALE];
  return {
    locale,
    t(key, params) {
      const template = active[key] ?? fallback[key];
      return template === undefined ? key : format(template, params);
    },
  };
}

let active: Translator = createClientTranslator('en');

/** Switch the panel language; the model calls this after every status refresh. */
export function setClientLocale(locale: Locale | string): void {
  active = createClientTranslator((normalizeLocale(locale) ?? FALLBACK_LOCALE) as Locale);
}

/** Current panel locale. */
export function clientLocale(): Locale {
  return active.locale;
}

/** Translate one key for the panel. */
export function ct(key: MessageKey, params?: MessageParams): string {
  return active.t(key, params);
}

/**
 * Format an epoch timestamp for the panel using the active locale.
 *
 * Uses the browser's own Intl data, so no extra locale tables are bundled.
 */
export function formatDate(value: number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(clientLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(new Date(value));
}
