import fs from 'node:fs/promises';
import os from 'node:os';
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

/**
 * Verdict for one path.
 *
 * `outside` still runs, but only after explicit approval. `code` explains why
 * the path was not auto-approved so the policy can refuse automatic writes for
 * reasons it cannot verify (unresolvable path, network share, mounted drive).
 */
export type PathVerdict =
  | { kind: 'allow' }
  | { kind: 'outside'; code: OutsideCode }
  | { kind: 'deny'; code: DenyCode };

/** Hard refusals; no mode overrides these. */
export type DenyCode =
  | 'INVALID_PATH'
  | 'UNC_PATH'
  | 'DEVICE_PATH'
  | 'STATE_FILE'
  | 'SYSTEM_PATH'
  | 'SYMLINK_ESCAPE';

/** Soft refusals that require per-operation approval. */
export type OutsideCode =
  | 'OUTSIDE_ROOTS'
  | 'UNVERIFIED_PATH'
  | 'MOUNTED_DRIVE'
  | 'CROSS_FILESYSTEM';

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

/** Network shares: `\\server\share` and `//server/share` are never verifiable. */
function isUnc(value: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(value);
}

/** Win32 device namespaces (`\\?\`, `\\.\`) address raw devices, not files. */
function isDevice(value: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(value);
}

/** Windows drives mounted into a POSIX distribution, where POSIX modes are inert. */
const MOUNT_PREFIXES = ['/mnt/', '/media/', '/run/media/', '/Volumes/'] as const;

function mountedPrefix(value: string): string | null {
  return MOUNT_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? null;
}

/**
 * Filesystem identity of a POSIX path, used to detect a jump between the Linux
 * filesystem and a mounted Windows drive. Symlinks are already resolved by the
 * caller, so the first two segments are a stable identity here.
 */
function volumeOf(value: string): string {
  const parts = value.split('/').filter(Boolean);
  const mount = mountedPrefix(value);
  if (mount) return `mount:${mount}${parts.slice(mount.split('/').filter(Boolean).length).at(0) ?? ''}`;
  return 'posix';
}

/** Resolve `~`-free, environment-derived roots without trusting caller input. */
function safeRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.normalize(trimmed);
}

/** The local user's home directory, validated; `null` when unusable. */
export function localHome(): string | null {
  return safeRoot(os.homedir()) ?? safeRoot(process.env.HOME) ?? null;
}

/**
 * Resolve the deepest existing ancestor so a symbolic link or NTFS junction
 * cannot move the effective target outside the allowed roots. Paths that do not
 * exist yet are joined back onto their resolved parent. When the current host
 * cannot resolve the other system's paths, the lexical path is returned and the
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

/** All roots the user already approved for this operation. */
function allowedRoots(context: PathGuardContext): string[] {
  return [...context.roots, ...(context.workspace ? [context.workspace] : [])];
}

/**
 * Classify one path.
 *
 * Order matters: shape refusals first (relative, network, device), then denied
 * roots (state, system), then real-path resolution, then the allowed roots. A
 * path that escapes through a symbolic link is denied outright rather than
 * silently downgraded to approval, because the user approved a different
 * location. A path the current host cannot resolve is never auto-approved.
 */
export async function classifyPath(value: string, context: PathGuardContext): Promise<PathVerdict> {
  const { target, mode } = context;
  const impl = pathFor(target);
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return { kind: 'deny', code: 'INVALID_PATH' };
  }
  if (isDevice(value)) return { kind: 'deny', code: 'DEVICE_PATH' };
  if (isUnc(value)) return { kind: 'deny', code: 'UNC_PATH' };
  if (!impl.isAbsolute(value)) return { kind: 'deny', code: 'INVALID_PATH' };
  const lexical = normalizeForTarget(target, value);
  if (underAny(context.denied.state, lexical, target)) return { kind: 'deny', code: 'STATE_FILE' };
  if (mode !== 'full-access' && underAny(context.denied.system, lexical, target)) {
    return { kind: 'deny', code: 'SYSTEM_PATH' };
  }
  if (!context.resolvable) return { kind: 'outside', code: 'UNVERIFIED_PATH' };

  const effective = await resolveRealTarget(target, lexical);
  if (underAny(context.denied.state, effective, target)) return { kind: 'deny', code: 'STATE_FILE' };
  if (mode !== 'full-access' && underAny(context.denied.system, effective, target)) {
    return { kind: 'deny', code: 'SYSTEM_PATH' };
  }
  const roots = allowedRoots(context);
  // A symlink or junction that resolves outside every allowed root is an
  // escape attempt, including a jump from the workspace into a mounted drive.
  if (effective !== lexical && roots.length && !underAny(roots, effective, target)) {
    return { kind: 'deny', code: 'SYMLINK_ESCAPE' };
  }
  if (mode === 'full-access') return { kind: 'allow' };
  if (mountedPrefix(effective)) return { kind: 'outside', code: 'MOUNTED_DRIVE' };
  if (context.workspace && volumeOf(effective) !== volumeOf(path.posix.normalize(context.workspace))) {
    if (target === 'wsl') return { kind: 'outside', code: 'CROSS_FILESYSTEM' };
  }
  if (underAny(roots, effective, target)) return { kind: 'allow' };
  return { kind: 'outside', code: 'OUTSIDE_ROOTS' };
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

/**
 * Every home-derived root that must stay denied for the target system.
 *
 * `HOME` (POSIX) and `USERPROFILE` (Windows) are read from the process
 * environment, never from a caller-supplied value, so a request cannot redirect
 * the secret roots by claiming a different home directory.
 */
export function homeSecretRoots(target: GrantTarget): string[] {
  const roots = new Set<string>();
  const candidates =
    target === 'windows'
      ? [process.env.USERPROFILE, process.env.HOMEDRIVE && process.env.HOMEPATH ? path.win32.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : undefined, process.env.HOME]
      : [process.env.HOME, process.env.USERPROFILE];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const impl = pathFor(target);
    if (!impl.isAbsolute(trimmed)) continue;
    for (const root of defaultSecretRoots(target, impl.normalize(trimmed))) roots.add(root);
  }
  return [...roots];
}
