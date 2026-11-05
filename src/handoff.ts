// Network destinations remain loopback-only. Desktop is an allowed parent, never a server URL.
export const DESKTOP_ORIGIN = 'dsh-app://app';

import type { HandoffPayload } from './handoff-auth.js';

/** Handoff fields delivered through the launch URL fragment. */
export interface Handoff extends HandoffPayload {
  parentOrigin: string | null;
}

/** Accept the Desktop app origin or a verified local HTTP origin. */
export function appOrigin(value: unknown): string | null {
  if (value === DESKTOP_ORIGIN || value === DESKTOP_ORIGIN + '/') return DESKTOP_ORIGIN;
  return localOrigin(value);
}

/** Parent URL used to return from an embedded environment. */
export function parentUrl(origin: string | null): string | null {
  return appOrigin(origin) === DESKTOP_ORIGIN ? 'dsh://open' : localOrigin(origin);
}

/** Validate a loopback HTTP origin; anything else returns null. */
export function localOrigin(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Build the launch URL for one verified Linux DSH instance. */
export function handoffUrl(url: string, handoff: Handoff): string {
  const destination = new URL(url);
  if (!localOrigin(destination.origin)) throw new Error('DSH returned an invalid local address.');
  destination.hash =
    'dsh-wsl=' +
    encodeURIComponent(
      JSON.stringify({
        ...handoff,
        parentOrigin: appOrigin(handoff.parentOrigin),
      }),
    );
  return destination.href;
}

/** Parse and validate a handoff fragment; returns null for anything unexpected. */
export function readHandoff(hash: string | null | undefined): Handoff | null {
  if (!hash?.startsWith('#dsh-wsl=') || hash.length > 16000) return null;
  try {
    // The hash carries either the whole handoff record (`settings` nested, as
    // `handoffUrl` writes it) or the flat v0.7.0 shape.
    const parsed = JSON.parse(decodeURIComponent(hash.slice(9))) as Partial<HandoffPayload> & {
      settings?: Partial<HandoffPayload>;
    };
    const settings = parsed.settings ?? parsed;
    if (
      typeof parsed.id !== 'string' ||
      parsed.id.length > 100 ||
      typeof settings.distro !== 'string' ||
      typeof settings.user !== 'string' ||
      typeof settings.directory !== 'string' ||
      !settings.directory.startsWith('/') ||
      /[\x00-\x1f]/.test(settings.directory)
    ) {
      return null;
    }
    return {
      id: parsed.id,
      distro: settings.distro,
      user: settings.user,
      directory: settings.directory,
      parentOrigin: appOrigin(parsed.parentOrigin),
      ...(parsed.proof ? { issuedAt: parsed.issuedAt, proof: parsed.proof } : {}),
    };
  } catch {
    return null;
  }
}
