import { randomUUID } from 'node:crypto';
import { BridgeError, ensure } from '../errors.js';
import { t } from '../i18n/index.js';
import { localizedReason, mergeReason, type LocalizedReason } from '../policy.js';
import { classifyPath, isInside, isResolvable, type DeniedRoots } from './paths.js';
import {
  CAPABILITIES,
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_PERMISSION_MODE,
  MAX_GRANT_LIFETIME_MS,
  MAX_MODE_LIFETIME_MS,
  PERMISSION_MODES,
  type Capability,
  type GrantTarget,
  type GrantInput,
  type ModeChangeInput,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionMode,
  type PermissionRequest,
  type PermissionState,
  type PolicyAuthority,
  type UserSurfaceEvidence,
} from './types.js';

export * from './types.js';
export * from './paths.js';

/** Phrase a user must type to enable Full Access. */
export const FULL_ACCESS_PHRASE = 'FULL ACCESS';

/**
 * Authorities minted by this process. A policy mutation is accepted only when
 * it carries a member of this set, so a caller cannot manufacture authorisation
 * by setting a boolean field.
 */
const MINTED_AUTHORITIES = new WeakSet<PolicyAuthority>();

/**
 * Mint an authority object from verified evidence.
 *
 * - `control-route` is the authenticated DSH control route the panel calls.
 * - `interactive-cli` is a terminal session (`stdin.isTTY`); a tool-spawned
 *   child process has no terminal, so `dsh-wsl permissions` cannot be driven
 *   by the agent.
 */
export function createUserSurfaceAuthority(evidence: UserSurfaceEvidence): PolicyAuthority {
  if (evidence.kind === 'control-route') {
    ensure(evidence.authenticated === true, 'PERMISSION_DENIED', 'permissions.denied.userSurface');
  } else {
    ensure(evidence.tty === true, 'PERMISSION_DENIED', 'permissions.denied.userSurface');
  }
  const authority: PolicyAuthority = Object.freeze({ surface: evidence.kind });
  MINTED_AUTHORITIES.add(authority);
  return authority;
}

/** Public guard for callers that mutate policy state on the user's behalf. */
export function assertUserSurface(value: unknown): asserts value is PolicyAuthority {
  assertAuthority(value);
}

/** Reject anything that is not an authority minted by this process. */
function assertAuthority(value: unknown): asserts value is PolicyAuthority {
  ensure(
    typeof value === 'object' && value !== null && MINTED_AUTHORITIES.has(value as PolicyAuthority),
    'PERMISSION_DENIED',
    'permissions.denied.userSurface',
  );
}

/** Environment facts the policy needs to classify paths. */
export interface GuardEnvironment {
  denied: DeniedRoots;
  roots: string[];
  workspace: string | null;
}

/** Field names a tool call must never carry, because they would change the policy. */
const FORBIDDEN_ARGUMENT_KEYS = [
  'mode',
  'permissionMode',
  'permissions',
  'permission',
  'grant',
  'grants',
  'userInitiated',
  'confirm',
  'authority',
  'hours',
];

/**
 * Reject tool arguments that try to influence the permission policy.
 * This runs before every handler so an added or forwarded argument cannot
 * silently become a policy field later.
 */
export function assertNoPolicyArguments(args: unknown): void {
  if (!args || typeof args !== 'object') return;
  for (const key of Object.keys(args as Record<string, unknown>)) {
    ensure(
      !FORBIDDEN_ARGUMENT_KEYS.includes(key),
      'INVALID_ARGUMENT',
      'permissions.denied.agentSwitch',
    );
  }
}

/** A Full Access window is only accepted inside its persisted, capped range. */
function validModeWindow(state: Partial<PermissionState>, now: number): boolean {
  const { modeIssuedAt: issuedAt, modeExpiresAt: expiresAt } = state;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return false;
  const start = issuedAt as number;
  const end = expiresAt as number;
  return (
    end > start &&
    end - start <= MAX_MODE_LIFETIME_MS &&
    end > now &&
    start <= now + CLOCK_SKEW_TOLERANCE_MS
  );
}

/**
 * Parse the persisted permission state, falling back to the strict default.
 *
 * Anything that cannot be trusted is dropped rather than repaired: an unknown
 * mode becomes Protected, an expired or incomplete Full Access window becomes
 * Protected, and malformed grants are discarded. A damaged or hand-edited state
 * file therefore narrows permissions, never widens them.
 */
export function parsePermissionState(value: unknown, now = Date.now()): PermissionState {
  const source = (value ?? {}) as Partial<PermissionState>;
  const grants: PermissionGrant[] = [];
  for (const item of Array.isArray(source.grants) ? source.grants : []) {
    const parsed = parseGrant(item);
    if (parsed && (parsed.expiresAt === null || parsed.expiresAt > now)) grants.push(parsed);
  }
  const requested = PERMISSION_MODES.includes(source.mode as PermissionMode)
    ? (source.mode as PermissionMode)
    : DEFAULT_PERMISSION_MODE;
  const mode =
    requested === 'full-access' && !validModeWindow(source, now) ? DEFAULT_PERMISSION_MODE : requested;
  if (mode === 'full-access') {
    return {
      mode,
      modeIssuedAt: source.modeIssuedAt as number,
      modeExpiresAt: source.modeExpiresAt as number,
      grants,
    };
  }
  return { mode, modeIssuedAt: null, modeExpiresAt: null, grants };
}

function parseGrant(value: unknown): PermissionGrant | null {
  if (!value || typeof value !== 'object') return null;
  const grant = value as Partial<PermissionGrant>;
  if (
    typeof grant.id !== 'string' ||
    !CAPABILITIES.includes(grant.capability as Capability) ||
    !['wsl', 'windows'].includes(grant.target as string) ||
    (grant.root !== null && typeof grant.root !== 'string') ||
    !Number.isSafeInteger(grant.createdAt) ||
    (grant.expiresAt !== null && !Number.isSafeInteger(grant.expiresAt))
  ) {
    return null;
  }
  if (typeof grant.root === 'string' && !/^(?:\/|[A-Za-z]:[\\/])/.test(grant.root)) return null;
  return {
    id: grant.id,
    capability: grant.capability as Capability,
    target: grant.target as GrantTarget,
    root: grant.root ?? null,
    createdAt: grant.createdAt as number,
    expiresAt: (grant.expiresAt ?? null) as number | null,
  };
}

function parseGrantInput(value: unknown, now: number): PermissionGrant {
  const input = (value ?? {}) as Partial<GrantInput>;
  ensure(
    CAPABILITIES.includes(input.capability as Capability),
    'INVALID_ARGUMENT',
    'errors.forbiddenValue',
    { name: 'capability' },
  );
  ensure(
    input.target === 'wsl' || input.target === 'windows',
    'INVALID_ARGUMENT',
    'errors.forbiddenValue',
    { name: 'target' },
  );
  ensure(
    typeof input.hours === 'number' && Number.isFinite(input.hours) && input.hours > 0,
    'INVALID_ARGUMENT',
    'errors.integer',
    { name: 'hours', min: 1, max: 24 },
  );
  const hours = Math.min(input.hours, 24);
  const root = input.root === undefined || input.root === null || input.root === '' ? null : String(input.root);
  if (root !== null) {
    const absolute = input.target === 'windows' ? /^[A-Za-z]:[\\/]/ : /^\//;
    ensure(absolute.test(root), 'INVALID_ARGUMENT', 'errors.forbiddenValue', { name: 'root' });
  }
  // A command cannot be confined to a path, so non-path capabilities need the
  // widest grant; the panel states that explicitly.
  if ((input.capability === 'exec' || input.capability === 'job' || input.capability === 'windows') && root !== null) {
    throw new BridgeError('INVALID_ARGUMENT', t('permissions.denied.untrustedGrant'));
  }
  return {
    id: randomUUID(),
    capability: input.capability as Capability,
    target: input.target,
    root,
    createdAt: now,
    expiresAt: now + Math.round(hours * 60 * 60 * 1000),
  };
}

/**
 * The single decision point for cross-system operations.
 *
 * The policy is deliberately small and synchronous except for path
 * classification: mode, grants, and the local facts needed to classify paths.
 * It never inspects command text; a command can do anything the user can, so
 * only an explicit approval or a user grant authorizes it.
 */
export interface PolicyOptions {
  /** Injectable wall clock; tests use it to simulate expiry and clock jumps. */
  now?: () => number;
}

export class PermissionPolicy {
  private state: PermissionState;
  private readonly now: () => number;
  /** Highest wall-clock value this instance has observed. */
  private lastSeen: number;
  /** Set once a backwards clock jump is observed; Full Access stays off. */
  private clockJump = false;

  constructor(initial: unknown = undefined, options: PolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lastSeen = this.now();
    this.state = parsePermissionState(initial, this.lastSeen);
    this.refresh();
  }

  get mode(): PermissionMode {
    this.refresh();
    return this.state.mode;
  }

  /** True when the clock moved backwards and Full Access was withdrawn. */
  get clockTampered(): boolean {
    return this.clockJump;
  }

  /** Deadline of the running Full Access window, if any. */
  get modeExpiresAt(): number | null {
    this.refresh();
    return this.state.modeExpiresAt;
  }

  get grants(): readonly PermissionGrant[] {
    return this.state.grants;
  }

  snapshot(): PermissionState {
    this.refresh();
    return {
      mode: this.state.mode,
      modeIssuedAt: this.state.modeIssuedAt,
      modeExpiresAt: this.state.modeExpiresAt,
      grants: this.state.grants.map((grant) => ({ ...grant })),
    };
  }

  private withdraw(): void {
    this.state.mode = DEFAULT_PERMISSION_MODE;
    this.state.modeIssuedAt = null;
    this.state.modeExpiresAt = null;
  }

  /**
   * Enforce the time box on every read.
   *
   * Full Access ends when the persisted deadline passes, when the persisted
   * window is inconsistent, or when the wall clock moves backwards by more than
   * the skew tolerance. Withdrawal is immediate and permanent for that window:
   * the user has to enter Full Access again.
   */
  private refresh(): void {
    const now = this.now();
    if (now < this.lastSeen - CLOCK_SKEW_TOLERANCE_MS) this.clockJump = true;
    this.lastSeen = Math.max(this.lastSeen, now);
    if (this.state.mode !== 'full-access') {
      this.state.modeIssuedAt = null;
      this.state.modeExpiresAt = null;
      return;
    }
    if (this.clockJump || !validModeWindow(this.state, now)) {
      this.withdraw();
      return;
    }
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((grant) => grant.expiresAt === null || grant.expiresAt > now);
    if (this.state.grants.length !== before) {
      // Expired grants are dropped; callers persist from `snapshot()`.
      this.dirty = true;
    }
  }

  /** True when `snapshot()` differs from the last persisted value. */
  private dirty = false;

  get needsPersist(): boolean {
    return this.dirty;
  }

  /** Called by the persistence layer once `snapshot()` has been written. */
  markPersisted(): void {
    this.dirty = false;
  }

  /** Drop expired grants; returns true when anything changed. */
  prune(now = this.now()): boolean {
    this.refresh();
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((grant) => grant.expiresAt === null || grant.expiresAt > now);
    return this.state.grants.length !== before;
  }

  /**
   * Change the mode. Full Access additionally requires the exact phrase, and
   * every change requires `userInitiated`, which only the control route and the
   * CLI set after a user action.
   */
  setMode(input: ModeChangeInput, authority: unknown): PermissionState {
    assertAuthority(authority);
    ensure(
      PERMISSION_MODES.includes(input.mode),
      'INVALID_ARGUMENT',
      'permissions.denied.unknownMode',
      { mode: String(input.mode) },
    );
    const now = this.now();
    if (input.mode === 'full-access') {
      // Every entry needs the phrase again, including a restart of the window,
      // so a running session cannot slide its own deadline forward.
      ensure(
        input.confirm === FULL_ACCESS_PHRASE,
        'PERMISSION_DENIED',
        'permissions.fullAccess.confirm',
      );
      const hours = typeof input.hours === 'number' && Number.isFinite(input.hours) ? input.hours : 24;
      const lifetime = Math.min(Math.max(hours, 1 / 60), 24) * 60 * 60 * 1000;
      this.state.mode = 'full-access';
      this.state.modeIssuedAt = now;
      this.state.modeExpiresAt = now + Math.min(Math.round(lifetime), MAX_MODE_LIFETIME_MS);
    } else {
      this.state.mode = input.mode;
      this.state.modeIssuedAt = null;
      this.state.modeExpiresAt = null;
    }
    this.clockJump = false;
    this.lastSeen = now;
    this.dirty = true;
    return this.snapshot();
  }

  /** Create one standing grant from an explicit user action. */
  addGrant(value: unknown, now = this.now()): PermissionGrant {
    const grant = parseGrantInput(value, now);
    const horizon = now + MAX_GRANT_LIFETIME_MS;
    if (grant.expiresAt !== null && grant.expiresAt > horizon) grant.expiresAt = horizon;
    this.state.grants = [...this.state.grants.filter((item) => item.id !== grant.id), grant];
    this.dirty = true;
    return { ...grant };
  }

  /** Revoke one grant by id. */
  revoke(id: unknown): boolean {
    ensure(typeof id === 'string' && id.length > 0 && id.length <= 100, 'INVALID_ARGUMENT', 'errors.forbiddenValue', {
      name: 'id',
    });
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((grant) => grant.id !== id);
    if (this.state.grants.length !== before) this.dirty = true;
    return this.state.grants.length !== before;
  }

  /** Human-readable approval reason for one request, localized for every locale. */
  reason(request: PermissionRequest): LocalizedReason {
    switch (request.capability) {
      case 'exec':
        return localizedReason('permissions.reason.exec', { target: request.target });
      case 'write':
        return localizedReason('permissions.reason.write', { target: request.target, path: request.path ?? '' });
      case 'copy':
        return localizedReason('permissions.reason.copy', {
          source: request.paths?.[0] ?? '',
          destination: request.paths?.[1] ?? request.path ?? '',
        });
      case 'windows':
        return localizedReason('permissions.reason.windows', { action: request.action ?? '' });
      case 'job':
        return localizedReason('permissions.reason.job', { target: request.target, action: request.action ?? '' });
    }
  }

  /** Grants matching this request, ignoring expiry (already pruned). */
  matches(request: PermissionRequest): PermissionGrant | null {
    const now = this.now();
    for (const grant of this.state.grants) {
      if (grant.capability !== request.capability || grant.target !== request.target) continue;
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
      if (grant.root === null) return grant;
      const candidate = request.path;
      if (!candidate || !isInside(grant.root, candidate, request.target)) continue;
      return grant;
    }
    return null;
  }

  /**
   * Evaluate one operation. Path classification runs first so a denied path is
   * refused even in Full Access (state and credential files);
   * `outside` means the path is not inside the workspace and needs approval.
   */
  async evaluate(request: PermissionRequest, environment: GuardEnvironment): Promise<PermissionDecision> {
    this.refresh();
    const paths = [request.path, ...(request.paths ?? [])].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const resolvable = isResolvable(request.target);
    /** Codes that force approval because the policy could not verify the path. */
    const pending = new Set<string>();
    for (const value of paths) {
      const verdict = await classifyPath(value, {
        target: request.target,
        mode: this.state.mode,
        workspace: environment.workspace,
        denied: environment.denied,
        roots: environment.roots,
        resolvable,
      });
      if (verdict.kind === 'deny') {
        return { kind: 'deny', code: verdict.code, reason: t(denyKey(verdict.code), { path: value }) };
      }
      if (verdict.kind === 'outside') pending.add(verdict.code);
    }
    // A write the policy cannot verify is never auto-approved, not even in Full
    // Access: the approval prompt is the only truthful protection left.
    const unverified = pending.has('UNVERIFIED_PATH');
    // Mounted Windows drives and cross-filesystem targets resolve, but Linux
    // permission bits do not protect them, so a grant is not enough either.
    const weak = unverified || pending.has('MOUNTED_DRIVE') || pending.has('CROSS_FILESYSTEM');
    if (this.state.mode === 'full-access' && !unverified) return { kind: 'allow', reason: 'full-access' };
    if (this.state.mode === 'trusted' && !weak && this.matches(request)) {
      return { kind: 'allow', reason: 'granted' };
    }
    let reason = this.reason(request);
    for (const code of pending) reason = mergeReason(reason, askReason(code, paths));
    return { kind: 'ask', reason };
  }
}

/** Localized reason for a hard refusal. */
function denyKey(code: string): Parameters<typeof t>[0] {
  switch (code) {
    case 'STATE_FILE':
      return 'permissions.denied.stateFile';
    case 'SYMLINK_ESCAPE':
      return 'permissions.denied.symlink';
    case 'SYSTEM_PATH':
      return 'permissions.denied.systemPath';
    case 'UNC_PATH':
      return 'permissions.denied.uncPath';
    case 'DEVICE_PATH':
      return 'permissions.denied.devicePath';
    case 'INVALID_PATH':
      return 'permissions.denied.invalidPath';
    default:
      return 'permissions.denied.outsideRoots';
  }
}

/** Localized reason for a path that needs per-operation approval. */
function askReason(code: string, paths: string[]): LocalizedReason {
  const path = paths[0] ?? '';
  switch (code) {
    case 'UNVERIFIED_PATH':
      return localizedReason('permissions.ask.unverifiedPath', { path });
    case 'MOUNTED_DRIVE':
      return localizedReason('permissions.ask.mountedDrive', { path });
    case 'CROSS_FILESYSTEM':
      return localizedReason('permissions.ask.crossFilesystem', { path });
    default:
      return localizedReason('permissions.denied.outsideRoots', { path });
  }
}
