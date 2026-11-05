/**
 * Node-side translation entry point: the shared core plus environment
 * detection and the process-wide translator.
 */
import {
  createTranslator,
  isLocale,
  normalizeLocale,
  FALLBACK_LOCALE,
  type Locale,
} from './core.js';
import type { MessageKey, MessageParams, Translator } from './core.js';

export * from './core.js';

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

export { createTranslator };
