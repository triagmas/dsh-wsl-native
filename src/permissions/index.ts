import { randomUUID } from 'node:crypto';
import { BridgeError, ensure } from '../errors.js';
import { t } from '../i18n/index.js';
import { localizedReason, mergeReason, type LocalizedReason } from '../policy.js';
import { classifyPath, isInside, isResolvable, type DeniedRoots } from './paths.js';
import {
  CAPABILITIES,
  DEFAULT_PERMISSION_MODE,
  MAX_GRANT_LIFETIME_MS,
  PERMISSION_MODES,
  type Capability,
  type GrantTarget,
  type GrantInput,
  type PermissionDecision,
  type PermissionGrant,
  type PermissionMode,
  type PermissionRequest,
  type PermissionState,
} from './types.js';

export * from './types.js';
export * from './paths.js';

/** Phrase a user must type to enable Full Access. */
export const FULL_ACCESS_PHRASE = 'FULL ACCESS';

/** Input accepted by {@link PermissionPolicy.setMode}. */
export interface ModeChangeInput {
  mode: PermissionMode;
  /** Only the authenticated user surface sets this; tools never can. */
  userInitiated: boolean;
  confirm?: string;
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

/** Parse the persisted permission state, falling back to the strict default. */
export function parsePermissionState(value: unknown): PermissionState {
  const source = (value ?? {}) as Partial<PermissionState>;
  const mode = PERMISSION_MODES.includes(source.mode as PermissionMode)
    ? (source.mode as PermissionMode)
    : DEFAULT_PERMISSION_MODE;
  const grants: PermissionGrant[] = [];
  for (const item of Array.isArray(source.grants) ? source.grants : []) {
    const parsed = parseGrant(item);
    if (parsed) grants.push(parsed);
  }
  return { mode, grants };
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
export class PermissionPolicy {
  private state: PermissionState;

  constructor(initial: unknown = undefined) {
    this.state = parsePermissionState(initial);
    this.prune();
  }

  get mode(): PermissionMode {
    return this.state.mode;
  }

  get grants(): readonly PermissionGrant[] {
    return this.state.grants;
  }

  snapshot(): PermissionState {
    return { mode: this.state.mode, grants: this.state.grants.map((grant) => ({ ...grant })) };
  }

  /** Drop expired grants; returns true when anything changed. */
  prune(now = Date.now()): boolean {
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((grant) => grant.expiresAt === null || grant.expiresAt > now);
    return this.state.grants.length !== before;
  }

  /**
   * Change the mode. Full Access additionally requires the exact phrase, and
   * every change requires `userInitiated`, which only the control route and the
   * CLI set after a user action.
   */
  setMode(input: ModeChangeInput): PermissionState {
    ensure(
      input.userInitiated === true,
      'PERMISSION_DENIED',
      'permissions.denied.agentSwitch',
    );
    ensure(
      PERMISSION_MODES.includes(input.mode),
      'INVALID_ARGUMENT',
      'permissions.denied.unknownMode',
      { mode: String(input.mode) },
    );
    if (input.mode === 'full-access' && this.state.mode !== 'full-access') {
      ensure(
        input.confirm === FULL_ACCESS_PHRASE,
        'PERMISSION_DENIED',
        'permissions.fullAccess.confirm',
      );
    }
    this.state.mode = input.mode;
    return this.snapshot();
  }

  /** Create one standing grant from an explicit user action. */
  addGrant(value: unknown, now = Date.now()): PermissionGrant {
    const grant = parseGrantInput(value, now);
    const horizon = now + MAX_GRANT_LIFETIME_MS;
    if (grant.expiresAt !== null && grant.expiresAt > horizon) grant.expiresAt = horizon;
    this.state.grants = [...this.state.grants.filter((item) => item.id !== grant.id), grant];
    return { ...grant };
  }

  /** Revoke one grant by id. */
  revoke(id: unknown): boolean {
    ensure(typeof id === 'string' && id.length > 0 && id.length <= 100, 'INVALID_ARGUMENT', 'errors.forbiddenValue', {
      name: 'id',
    });
    const before = this.state.grants.length;
    this.state.grants = this.state.grants.filter((grant) => grant.id !== id);
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
    const now = Date.now();
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
    const paths = [request.path, ...(request.paths ?? [])].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const resolvable = isResolvable(request.target);
    let outside = false;
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
        const key =
          verdict.code === 'STATE_FILE'
            ? 'permissions.denied.stateFile'
            : verdict.code === 'SYMLINK_ESCAPE'
              ? 'permissions.denied.symlink'
              : verdict.code === 'SYSTEM_PATH'
                ? 'permissions.denied.systemPath'
                : 'permissions.denied.outsideRoots';
        return { kind: 'deny', code: verdict.code, reason: t(key, { path: value }) };
      }
      if (verdict.kind === 'outside') outside = true;
    }
    if (this.state.mode === 'full-access') return { kind: 'allow', reason: 'full-access' };
    if (this.state.mode === 'trusted' && this.matches(request)) return { kind: 'allow', reason: 'granted' };
    const detail = this.reason(request);
    if (!outside) return { kind: 'ask', reason: detail };
    return {
      kind: 'ask',
      reason: mergeReason(detail, localizedReason('permissions.denied.outsideRoots', { path: paths[0] ?? '' })),
    };
  }
}
