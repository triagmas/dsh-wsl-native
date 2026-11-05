/**
 * Payload builders shared by the permission panel and its tests.
 *
 * The panel must send exactly what `PermissionPolicy` validates, so the rules
 * live here once: the UI renders from these results and the tests assert them
 * directly, without a DOM.
 */
import { FULL_ACCESS_PHRASE } from './permissions/phrase.js';
import type { MessageKey } from './i18n/en.js';
import type { PermissionMode } from './client-types.js';

/** Grant capabilities the panel offers (the host accepts these three). */
export const GRANT_CAPABILITIES = ['exec', 'write', 'copy'] as const;
export type GrantCapability = (typeof GRANT_CAPABILITIES)[number];

/** Grant targets: the whole Windows system or the whole Linux distribution. */
export const GRANT_TARGETS = ['windows', 'wsl'] as const;
export type GrantTarget = (typeof GRANT_TARGETS)[number];

/** Full Access durations offered in minutes; the host accepts 1 minute to 24 h. */
export const FULL_ACCESS_MINUTES = [1, 5, 15, 30, 60, 240, 1440] as const;

/** Grant lifetimes offered in hours; the host accepts 1 to 24. */
export const GRANT_HOURS = [1, 4, 8, 24] as const;

/**
 * A mode change request, ready for `permissions/mode`.
 *
 * The index signature keeps it assignable to the panel's `Record<string, unknown>`
 * payload type without a cast.
 */
export interface ModeRequest {
  [key: string]: unknown;
  mode: PermissionMode;
  confirm?: string;
  hours?: number;
}

/** A grant creation request, ready for `permissions/grant`. */
export interface GrantRequest {
  [key: string]: unknown;
  capability: GrantCapability;
  target: GrantTarget;
  root?: string;
  hours: number;
}

/** Structured validation result: a value, or a translation key to show. */
export type FormResult<T> = { ok: true; value: T } | { ok: false; error: MessageKey };

/** Path shape required for a grant root on each target. */
const ROOT_PATTERNS: Record<GrantTarget, RegExp> = {
  windows: /^[A-Za-z]:[\\/]/,
  wsl: /^\//,
};

/** True when the capability is limited to a directory. */
export function needsRoot(capability: GrantCapability): boolean {
  return capability !== 'exec';
}

/** Clamp minutes into the host-accepted window, in whole minutes. */
function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(1440, Math.max(1, Math.round(minutes)));
}

/**
 * Build the Full Access request.
 *
 * Protected and Trusted carry no confirmation and no lifetime; Full Access
 * requires the literal phrase and converts the chosen minutes into hours.
 */
export function buildModeRequest(
  mode: PermissionMode,
  confirm: string,
  minutes: number,
): FormResult<ModeRequest> {
  if (mode !== 'full-access') return { ok: true, value: { mode } };
  if (confirm !== FULL_ACCESS_PHRASE) return { ok: false, error: 'ui.permissions.confirmRequired' };
  return { ok: true, value: { mode, confirm, hours: clampMinutes(minutes) / 60 } };
}

/**
 * Build a grant request.
 *
 * `exec` always covers the whole target, so a root is rejected rather than
 * silently ignored; `write` and `copy` need an absolute root for that target.
 */
export function buildGrantRequest(input: {
  capability: GrantCapability;
  target: GrantTarget;
  root: string;
  hours: number;
}): FormResult<GrantRequest> {
  const root = input.root.trim();
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 24) {
    return { ok: false, error: 'ui.permissions.hoursInvalid' };
  }
  if (!needsRoot(input.capability)) {
    if (root) return { ok: false, error: 'ui.permissions.execNoRoot' };
    return {
      ok: true,
      value: { capability: input.capability, target: input.target, hours: input.hours },
    };
  }
  if (!root) return { ok: false, error: 'ui.permissions.rootRequired' };
  if (!ROOT_PATTERNS[input.target].test(root)) return { ok: false, error: 'ui.permissions.rootInvalid' };
  return {
    ok: true,
    value: { capability: input.capability, target: input.target, root, hours: input.hours },
  };
}

/** Human-readable duration for the Full Access picker. */
export function minutesLabelKey(minutes: number): MessageKey {
  return minutes >= 60 ? 'ui.permissions.hoursOption' : 'ui.permissions.minutesOption';
}

/** Value passed to `ct()` for `minutesLabelKey`. */
export function minutesLabelParams(minutes: number): { hours: number; minutes: number } {
  return { hours: minutes / 60, minutes };
}
