import fs from 'node:fs/promises';
import path from 'node:path';
import type { GrantTarget, PermissionMode } from './types.js';

/**
 * Absolute paths that tools must never modify, on top of the user's grants.
 * These are process- and configuration-critical, so they are denied even in
 * Full Access: changing them through a tool could silently widen the agent's
 * own permissions. Everything else in Full Access follows the Windows user's
 * real operating-system rights.
 */
export interface DeniedRoots {
  /** Plugin state (settings, inheritance baselines, runtime locks). */
  state: string[];
  /** Operating-system locations whose contents are not a workspace. */
  system: string[];
}

/** Verdict for one path. `outside` still runs, but after explicit approval. */
export type PathVerdict = { kind: 'allow' } | { kind: 'outside' } | { kind: 'deny'; code: string };

/** Inputs describing the current policy for one operation. */
export interface PathGuardContext {
  target: GrantTarget;
  mode: PermissionMode;
  workspace: string | null;
  denied: DeniedRoots;
  /** Extra roots the user approved for this workspace. */
  roots: string[];
  /** Whether the local process can resolve paths for this target. */
  resolvable: boolean;
}

const pathFor = (target: GrantTarget): typeof path.win32 => (target === 'windows' ? path.win32 : path.posix);

/** Normalize an absolute path for the target system. */
export function normalizeForTarget(target: GrantTarget, value: string): string {
  const impl = pathFor(target);
  return impl.normalize(value);
}

/** True when `candidate` equals `root` or lives below it (case-insensitive on Windows). */
export function isInside(root: string, candidate: string, target: GrantTarget): boolean {
  const impl = pathFor(target);
  const fold = (value: string): string => (target === 'windows' ? value.toLowerCase() : value);
  const normalizedRoot = fold(impl.normalize(root)).replace(/[\\/]+$/, '');
  const normalizedCandidate = fold(impl.normalize(candidate));
  if (normalizedRoot === '') return true;
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + impl.sep) ||
    // Windows accepts both separators in incoming values.
    (target === 'windows' &&
      normalizedCandidate.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/'))
  );
}

/**
 * Resolve the deepest existing ancestor so a symbolic link cannot move the
 * effective target outside the allowed roots. Paths that do not exist yet are
 * joined back onto their resolved parent. When the current host cannot resolve
 * the other system's paths, the lexical path is returned unchanged and the
 * caller must ask for approval instead of claiming a verification.
 */
export async function resolveRealTarget(target: GrantTarget, value: string): Promise<string> {
  const impl = pathFor(target);
  const missing: string[] = [];
  let candidate = impl.normalize(value);
  for (;;) {
    try {
      const real = await fs.realpath(candidate);
      return missing.length ? impl.join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return impl.normalize(value);
      const parent = impl.dirname(candidate);
      if (parent === candidate) return impl.normalize(value);
      missing.push(impl.basename(candidate));
      candidate = parent;
    }
  }
}

/** Whether the local process can resolve paths of the given target system. */
export function isResolvable(target: GrantTarget): boolean {
  if (target === 'wsl') return process.platform !== 'win32' || !!process.env.WSL_DISTRO_NAME;
  return process.platform === 'win32';
}

/** Matches one prefix against a path for the target system. */
function underAny(prefixes: readonly string[], candidate: string, target: GrantTarget): boolean {
  return prefixes.some((prefix) => isInside(prefix, candidate, target));
}

/**
 * Classify one path.
 *
 * Order matters: denied roots first (state, system), then the allowed roots.
 * A path that escapes through a symbolic link is denied outright rather than
 * silently downgraded to approval, because the user approved a different
 * location.
 */
export async function classifyPath(value: string, context: PathGuardContext): Promise<PathVerdict> {
  const { target, mode } = context;
  const impl = pathFor(target);
  if (!impl.isAbsolute(value)) return { kind: 'deny', code: 'INVALID_PATH' };
  const lexical = normalizeForTarget(target, value);
  if (underAny(context.denied.state, lexical, target)) return { kind: 'deny', code: 'STATE_FILE' };
  if (mode !== 'full-access' && underAny(context.denied.system, lexical, target)) {
    return { kind: 'deny', code: 'SYSTEM_PATH' };
  }
  let effective = lexical;
  if (context.resolvable) {
    effective = await resolveRealTarget(target, lexical);
    if (underAny(context.denied.state, effective, target)) return { kind: 'deny', code: 'STATE_FILE' };
    if (mode !== 'full-access' && underAny(context.denied.system, effective, target)) {
      return { kind: 'deny', code: 'SYSTEM_PATH' };
    }
    // A symlink that resolves outside every allowed root is an escape attempt.
    const allowed = [...context.roots, ...(context.workspace ? [context.workspace] : [])];
    if (effective !== lexical && allowed.length && !underAny(allowed, effective, target)) {
      return { kind: 'deny', code: 'SYMLINK_ESCAPE' };
    }
  }
  const roots = [...context.roots, ...(context.workspace ? [context.workspace] : [])];
  if (mode === 'full-access') return { kind: 'allow' };
  if (underAny(roots, effective, target)) return { kind: 'allow' };
  return { kind: 'outside' };
}

/** Default system locations that are never workspace content. */
export function defaultSystemRoots(target: GrantTarget): string[] {
  if (target === 'windows') {
    const environment = process.env;
    const windows = environment.SystemRoot || 'C:\\Windows';
    const drive = windows.slice(0, 2);
    return [
      windows,
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
      `${drive}\\ProgramData`,
      `${drive}\\$Recycle.Bin`,
      `${drive}\\System Volume Information`,
      `${drive}\\Recovery`,
    ];
  }
  return ['/etc', '/boot', '/dev', '/proc', '/sys', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/run', '/var/lib'];
}

/** User-level locations holding credentials or remote-control state. */
export function defaultSecretRoots(target: GrantTarget, home: string): string[] {
  const impl = pathFor(target);
  return target === 'windows'
    ? [impl.join(home, '.ssh'), impl.join(home, 'AppData', 'Roaming', '@deepseek-ai')]
    : [impl.join(home, '.ssh'), impl.join(home, '.dsh')];
}
