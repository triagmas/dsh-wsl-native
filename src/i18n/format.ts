/** Placeholder interpolation shared by the host and the browser bundle. */
import type { MessageParams } from './types.js';

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
