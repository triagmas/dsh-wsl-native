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

/**
 * Durable permission state stored with the plugin settings.
 *
 * Full Access is always time-boxed: `modeExpiresAt` and `modeIssuedAt` are
 * persisted with the mode so a restart cannot extend the window, and a state
 * file that claims Full Access without a valid window is downgraded to
 * Protected when it is loaded.
 */
export interface PermissionState {
  mode: PermissionMode;
  /** Epoch millisecond deadline for the active Full Access window. */
  modeExpiresAt: number | null;
  /** Epoch millisecond start of the active Full Access window. */
  modeIssuedAt: number | null;
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

/**
 * Longest accepted Full Access window. The ceiling applies to the stored
 * deadline, so lowering the constant also shortens an already running window.
 */
export const MAX_MODE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Wall-clock movement tolerated before the policy assumes the system clock was
 * changed and drops Full Access. Real clocks drift; supervised sessions do not
 * jump minutes backwards.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Brand proving that a policy mutation came from a human-facing surface.
 *
 * `userInitiated: true` is only a claim: anything that can call the policy can
 * set it. Authority objects instead can only be produced by
 * `createUserSurfaceAuthority`, which verifies evidence the agent path does not
 * have (an interactive terminal, or the authenticated control route).
 */
export interface PolicyAuthority {
  /** Which user-facing surface minted this authority. */
  readonly surface: 'control-route' | 'interactive-cli';
}

/** Evidence accepted when minting an authority object. */
export type UserSurfaceEvidence =
  | { kind: 'control-route'; authenticated: boolean }
  | { kind: 'interactive-cli'; tty: boolean };

/** Input accepted by a mode change coming from the user surface. */
export interface ModeChangeInput {
  mode: PermissionMode;
  /** Required when entering Full Access; must equal the exact phrase. */
  confirm?: string;
  /** Requested window length in hours; clamped to the 24 hour ceiling. */
  hours?: number;
}

/** Validation result for an untrusted grant payload. */
export interface GrantInput {
  capability: Capability;
  target: GrantTarget;
  root: string | null;
  hours: number;
}
