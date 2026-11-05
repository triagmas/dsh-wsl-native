import type { LocalizedReason } from '../policy.js';

/**
 * Permission model for cross-system operations.
 *
 * The mode is owned by the user. Tools cannot read it as an argument, cannot
 * change it, and cannot extend their own grants: every mutating entry point
 * lives on the authenticated control route or the CLI, which are user surfaces.
 */

/** Selectable permission modes, strictest first. */
export const PERMISSION_MODES = ['protected', 'trusted', 'full-access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Default mode for a fresh installation and for an unreadable settings file. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'protected';

/** Operation families a grant can authorize. */
export const CAPABILITIES = ['exec', 'write', 'copy', 'windows', 'job'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Systems a grant can target. `local` is never granted separately. */
export type GrantTarget = 'wsl' | 'windows';

/**
 * One standing permission the user created explicitly.
 * `root` is an absolute path prefix; `null` means "any path on this target".
 * `expiresAt` is an epoch millisecond deadline or `null` for no expiry.
 */
export interface PermissionGrant {
  id: string;
  capability: Capability;
  target: GrantTarget;
  root: string | null;
  createdAt: number;
  expiresAt: number | null;
}

/** Durable permission state stored with the plugin settings. */
export interface PermissionState {
  mode: PermissionMode;
  grants: PermissionGrant[];
}

/** Result of evaluating one operation against the current policy. */
export type PermissionDecision =
  | { kind: 'allow'; reason: 'full-access' | 'granted' }
  | { kind: 'ask'; reason: LocalizedReason }
  | { kind: 'deny'; code: string; reason: string };

/** One operation presented to the policy. */
export interface PermissionRequest {
  capability: Capability;
  target: GrantTarget;
  /** Absolute path the operation writes to, when it writes a file. */
  path?: string;
  /** Additional absolute paths the operation touches (copy source and destination). */
  paths?: string[];
  /** Windows action or job action, used for human-readable reasons. */
  action?: string;
  /** Directory the operation belongs to (the active workspace). */
  workspace?: string | null;
}

/** Longest accepted grant lifetime; a grant must not outlive a working session. */
export const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Validation result for an untrusted grderant payload. */
export interface GrantInput {
  capability: Capability;
  target: GrantTarget;
  root: string | null;
  hours: number;
}
