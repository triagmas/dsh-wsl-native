import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ConnectionPool, listDistros, type BridgeTarget } from './connector.js';
import { BridgeError, ensure, aborted, integer } from './errors.js';
import { linuxPath, distroName, parseWslUnc, type DistroInfo } from './paths.js';
import { t, detectLocale, resolveLocale, getLocale, setLocale, type Locale, LOCALES } from './i18n/index.js';
import {
  PermissionPolicy,
  assertUserSurface,
  defaultSecretRoots,
  defaultSystemRoots,
  homeSecretRoots,
  type DeniedRoots,
  type GuardEnvironment,
  type PermissionGrant,
  type PermissionState,
  type PolicyAuthority,
} from './permissions/index.js';
import type {
  FileReadResult,
  FileStatResult,
  JobStatusResult,
  StorageKind,
  TransferCommitResult,
  WindowsAction,
  WorkerInfo,
  WorkerMethod,
  WorkerParams,
  WorkerResult,
} from './worker-protocol.js';
import type { ProcessResult } from './process.js';

/** Pipeline version reported by the plugin to the panel. */
export const PLUGIN_VERSION = '0.8.0';

/** One environment identity: distribution plus Linux user. */
export interface WslSettings {
  distro: string;
  user: string;
  directory: string;
}

/** Remembered environment with its recent directories. */
export interface WslProfile extends WslSettings {
  recentDirectories: string[];
  storage?: StorageKind;
}

/** Persisted preferences (all optional in the file, normalized in memory). */
export interface WslPreferences {
  autoStartWsl: boolean;
  locale: Locale;
}

/** Plugin configuration, from the Cordis patch and the environment. */
export interface WslConfig {
  distro?: string;
  user?: string;
  directory?: string;
  settingsFile?: string;
  nativeRoot?: string;
  linuxNode?: string;
  windowsNode?: string;
  sourceProfile?: { home: string; dir: string; name: string };
  inheritanceStateHome?: string;
  /** Extra roots the user authorized for file operations. */
  permissionRoots?: string[];
}

/** Background job ownership, pinned to the environment that started it. */
export interface JobOwner {
  target: 'wsl' | 'windows';
  distro: string;
  user: string;
  directory: string;
}

/** Call options resolved for one bridge request. */
export interface CallOptions {
  distro?: string;
  user?: string;
  directory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  rpcTimeoutMs?: number;
}

/** Injected dependencies (tests replace the pool and the distribution list). */
export interface ServiceDependencies {
  pool?: ConnectionPool;
  listDistros?: () => Promise<DistroInfo[]>;
  settings?: WslSettings;
  jobs?: Map<string, JobOwner>;
}

/** Snapshot returned to the panel and the CLI status command. */
export interface ServiceStatus {
  version: string;
  host: string;
  mode: 'windows-host' | 'wsl-host' | 'unsupported';
  node: string;
  locale: Locale;
  locales: readonly Locale[];
  settings: WslSettings;
  preferences: WslPreferences;
  profiles: WslProfile[];
  distros: DistroInfo[];
  pool: ReturnType<ConnectionPool['snapshot']>;
  permissions: PermissionState;
  error: string | null;
}

/** Result of resolving one environment (settings + worker identity + storage). */
export interface ResolvedEnvironment {
  settings: WslSettings;
  info: WorkerInfo;
  storage: StorageKind;
}

/** Arguments shared by execute/files/windows/job. */
export interface ExecArgs {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
}

/** File tool arguments. */
export interface FileArgs {
  path: string;
  content?: string;
  expectedHash?: string;
  encoding?: 'utf8' | 'gb18030' | 'base64';
  offset?: number;
  limit?: number;
  hidden?: boolean;
  hash?: boolean;
}

/** Pinned environment identity of one background job. */
const environmentKey = (settings: { distro?: string; user?: string }): string =>
  JSON.stringify([settings.distro ?? '', settings.user ?? '']);

export { environmentKey };

/**
 * Host-side service: owns settings, remembered environments, the worker pool
 * and the permission policy. It never inspects command text; execution policy
 * is decided by {@link PermissionPolicy} and DSH approvals.
 */
export class WslService {
  readonly config: WslConfig;
  readonly pool: ConnectionPool;
  readonly jobs: Map<string, JobOwner>;
  permissions: PermissionPolicy;
  readonly settingsFile: string;
  readonly listDistros: () => Promise<DistroInfo[]>;
  readonly initialized: Promise<void>;
  settings: WslSettings;
  profiles: WslProfile[] = [];
  preferences: WslPreferences;
  settingsError: string | undefined;
  private readonly ownsPool: boolean;
  private changes: Promise<unknown> = Promise.resolve();
  private listCache: { value: DistroInfo[]; at: number } | null = null;
  private readonly pathCache = new Map<string, { value: { path: string }; at: number }>();

  constructor(config: WslConfig = {}, dependencies: ServiceDependencies = {}) {
    this.config = config;
    this.pool = dependencies.pool ?? new ConnectionPool(config);
    this.ownsPool = !dependencies.pool;
    this.listDistros = dependencies.listDistros ?? listDistros;
    this.settingsFile =
      config.settingsFile ??
      path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-wsl-native', 'settings.json');
    this.settings = dependencies.settings ?? {
      distro: config.distro ?? process.env.WSL_DISTRO_NAME ?? '',
      user: config.user ?? '',
      directory: config.directory ?? '',
    };
    this.preferences = { autoStartWsl: false, locale: detectLocale() };
    this.permissions = new PermissionPolicy();
    this.jobs = dependencies.jobs ?? new Map();
    this.initialized = dependencies.settings ? Promise.resolve() : this.loadSettings();
  }

  private async loadSettings(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')) as Partial<WslSettings> & {
        profiles?: unknown;
        preferences?: { autoStartWsl?: unknown; locale?: unknown };
        permissions?: unknown;
      };
      this.settings = this.validateSettings({ ...this.settings, ...data });
      const detected = detectLocale();
      this.preferences = {
        autoStartWsl: data.preferences?.autoStartWsl === true,
        locale: resolveLocale(data.preferences?.locale, detected),
      };
      setLocale(this.preferences.locale);
      this.permissions = new PermissionPolicy(data.permissions);
      const profiles = Array.isArray(data.profiles) ? data.profiles : [this.settings];
      const seen = new Set<string>();
      for (const item of profiles.slice(0, 32) as (WslSettings & {
        recentDirectories?: unknown;
        storage?: unknown;
      })[]) {
        try {
          const settings = this.validateSettings(item);
          const key = environmentKey(settings);
          if (seen.has(key)) continue;
          seen.add(key);
          const recentDirectories = [
            ...new Set([
              settings.directory,
              ...(Array.isArray(item.recentDirectories) ? (item.recentDirectories as unknown[]) : []),
            ]),
          ]
            .filter((value): value is string => typeof value === 'string' && value.startsWith('/') && !/[\x00-\x1f]/.test(value))
            .slice(0, 10);
          this.profiles.push({
            ...settings,
            recentDirectories,
            ...(['linux', 'windows-mount', 'other'].includes(item.storage as string)
              ? { storage: item.storage as StorageKind }
              : {}),
          });
        } catch {
          /* A damaged history item must not hide the usable active environment. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.settingsError = t('service.settingsUnreadable', { error: (error as Error).message });
      }
    }
  }

  /** Validate one environment identity from untrusted input. */
  validateSettings(profile: Partial<WslSettings>): WslSettings {
    const distro = profile.distro || '';
    if (distro) distroName(distro);
    const user = profile.user || '';
    ensure(
      typeof user === 'string' && user.length <= 128 && !/[\x00-\x1f]/.test(user) && !user.startsWith('-'),
      'INVALID_ARGUMENT',
      'service.invalidUser',
    );
    const directory = profile.directory ? linuxPath(profile.directory) : '';
    return { distro, user, directory };
  }

  /** Remembered profile for one identity. */
  profile(identity: Partial<WslSettings>): WslProfile | undefined {
    return this.profiles.find((item) => environmentKey(item) === environmentKey(identity));
  }

  /** A launcher owns an immutable identity while sharing the warm transport pool. */
  scope(settings: WslSettings): WslService {
    return new WslService(this.config, {
      pool: this.pool,
      settings: Object.freeze({ ...settings }),
      jobs: this.jobs,
      listDistros: () => this.distros(),
    });
  }

  /** Resolve and verify one environment without persisting it. */
  async resolveEnvironment(input: CallOptions = {}, signal?: AbortSignal): Promise<ResolvedEnvironment> {
    await this.initialized;
    const requested = this.validateSettings({
      distro: input.distro ?? this.settings.distro,
      user:
        input.user ??
        (input.distro && input.distro !== this.settings.distro
          ? (this.profiles.find((item) => item.distro === input.distro)?.user ?? '')
          : this.settings.user),
    });
    const options = await this.options({ ...requested, signal: signal ?? input.signal });
    ensure(
      (await this.distros()).some((distro) => distro.name === options.distro),
      'DISTRO_NOT_FOUND',
      'service.distroNotFound',
    );
    const info = await this.ping('wsl', options);
    const identity: WslSettings = {
      distro: options.distro as string,
      user: info.user || (options.user as string) || '',
      directory: '',
    };
    const profile = this.profile(identity) ?? this.profile(requested);
    const directory =
      input.directory ??
      profile?.directory ??
      (options.distro === this.settings.distro && requested.user === this.settings.user
        ? this.settings.directory
        : '');
    const resolvedDirectory = directory
      ? await this.normalized('wsl', directory, { ...options, ...identity })
      : info.home;
    const resolved = await this.call(
      'wsl',
      'directory.resolve',
      { path: resolvedDirectory },
      { ...options, ...identity },
    );
    aborted(signal);
    return {
      settings: { ...identity, directory: resolved.path },
      info,
      storage: resolved.storage,
    };
  }

  /** Verify, persist and activate one environment; concurrent calls stay ordered. */
  async switchEnvironment(input: CallOptions, { signal }: { signal?: AbortSignal } = {}): Promise<ResolvedEnvironment> {
    const change = this.changes.then(async () => {
      const result = await this.resolveEnvironment(input, signal);
      const next = result.settings;
      const previous = this.profile(next);
      const profiles: WslProfile[] = [
        {
          ...next,
          storage: result.storage,
          recentDirectories: [...new Set([next.directory, ...(previous?.recentDirectories ?? [])])].slice(0, 10),
        },
        ...this.profiles.filter((item) => environmentKey(item) !== environmentKey(next)),
      ].slice(0, 32);
      await this.persistSettings(next, profiles, this.preferences, signal);
      // Commit only after connection, directory resolution and persistence succeeded.
      this.settings = next;
      this.profiles = profiles;
      this.settingsError = undefined;
      return result;
    });
    this.changes = change.catch(() => {});
    return change;
  }

  /** Persist and activate one environment identity (no directory verification). */
  async saveSettings(input: CallOptions): Promise<WslSettings> {
    return (await this.switchEnvironment(input)).settings;
  }

  private async persistSettings(
    settings: WslSettings,
    profiles: WslProfile[],
    preferences: WslPreferences,
    signal?: AbortSignal,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    const temp = this.settingsFile + `.${randomUUID()}.tmp`;
    const payload = {
      ...settings,
      profiles,
      preferences,
      permissions: this.permissions.snapshot(),
    };
    try {
      await fs.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      aborted(signal);
      await fs.rename(temp, this.settingsFile);
      this.permissions.markPersisted();
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  /** Update preferences; only known fields are accepted. */
  async updatePreferences(
    input: { autoStartWsl?: unknown; locale?: unknown },
    { signal, onLocaleChange }: { signal?: AbortSignal; onLocaleChange?: (locale: Locale) => void } = {},
  ): Promise<WslPreferences> {
    ensure(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', 'errors.forbiddenValue', {
      name: 'preferences',
    });
    const keys = Object.keys(input);
    ensure(keys.length > 0 && keys.length <= 2, 'INVALID_ARGUMENT', 'errors.forbiddenValue', {
      name: 'preferences',
    });
    ensure(
      Object.keys(input).every((key) => ['autoStartWsl', 'locale'].includes(key)),
      'INVALID_ARGUMENT',
      'errors.forbiddenValue',
      { name: 'preferences' },
    );
    if (input.autoStartWsl !== undefined) {
      ensure(typeof input.autoStartWsl === 'boolean', 'INVALID_ARGUMENT', 'service.preferenceBoolean');
    }
    let locale: Locale | undefined;
    if (input.locale !== undefined) {
      ensure(
        typeof input.locale === 'string' && (LOCALES as readonly string[]).includes(input.locale),
        'INVALID_ARGUMENT',
        'errors.forbiddenValue',
        { name: 'locale' },
      );
      locale = input.locale as Locale;
    }
    const autoStartWsl = input.autoStartWsl as boolean | undefined;
    const change = this.changes.then(async () => {
      await this.initialized;
      const preferences: WslPreferences = {
        autoStartWsl: autoStartWsl === undefined ? this.preferences.autoStartWsl : autoStartWsl,
        locale: locale ?? this.preferences.locale,
      };
      await this.persistSettings(this.settings, this.profiles, preferences, signal);
      this.preferences = preferences;
      if (locale) {
        setLocale(locale);
        onLocaleChange?.(locale);
      }
      return preferences;
    });
    this.changes = change.catch(() => {});
    return change;
  }

  /**
   * Change the permission mode.
   *
   * `authority` must be a token minted by {@link createUserSurfaceAuthority}
   * from verified evidence (authenticated control route or an interactive
   * terminal). A plain `userInitiated: true` flag is not evidence and is not
   * accepted anywhere in this path.
   */
  async setPermissionMode(
    input: { mode: string; confirm?: string; hours?: number },
    authority: PolicyAuthority,
  ): Promise<PermissionState> {
    await this.initialized;
    const state = this.permissions.setMode(
      {
        mode: input.mode as PermissionState['mode'],
        confirm: input.confirm,
        hours: input.hours,
      },
      authority,
    );
    await this.persistPermissionState();
    return state;
  }

  /** Add one standing grant; requires the same user-surface authority. */
  async addPermissionGrant(input: unknown, authority: PolicyAuthority): Promise<PermissionGrant> {
    await this.initialized;
    assertUserSurface(authority);
    const grant = this.permissions.addGrant(input);
    await this.persistPermissionState();
    return grant;
  }

  /** Revoke one standing grant; requires the same user-surface authority. */
  async revokePermissionGrant(id: unknown, authority: PolicyAuthority): Promise<{ removed: boolean }> {
    await this.initialized;
    assertUserSurface(authority);
    const removed = this.permissions.revoke(id);
    if (removed) await this.persistPermissionState();
    return { removed };
  }

  /**
   * Persist a policy change produced by the clock (expired Full Access window or
   * expired grants) so a restart cannot resurrect it.
   */
  async persistPermissionStateIfNeeded(): Promise<boolean> {
    await this.initialized;
    if (!this.permissions.needsPersist) return false;
    await this.persistPermissionState();
    return true;
  }

  private async persistPermissionState(): Promise<void> {
    await this.persistSettings(this.settings, this.profiles, this.preferences);
  }

  /** Facts the permission policy needs to classify paths for this service. */
  guardEnvironment(): GuardEnvironment {
    const workspace = this.settings.directory || null;
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const denied: DeniedRoots = {
      state: [
        path.dirname(this.settingsFile),
        path.join(dshHome, '.credentials.yaml'),
        // Both HOME and USERPROFILE derived roots are denied, whatever the
        // caller claims; these are read from the process environment only.
        ...homeSecretRoots('wsl'),
        ...homeSecretRoots('windows'),
      ],
      system: [
        ...defaultSystemRoots('wsl'),
        ...defaultSecretRoots('windows', process.env.USERPROFILE || os.homedir()),
        ...defaultSystemRoots('windows'),
      ],
    };
    return {
      denied,
      roots: [...(this.config.permissionRoots ?? [])],
      workspace,
    };
  }

  /** Installed distributions, cached for 30 seconds. */
  async distros(refresh = false): Promise<DistroInfo[]> {
    if (!refresh && this.listCache && Date.now() - this.listCache.at < 30000) return this.listCache.value;
    const value = await this.listDistros();
    this.listCache = { value, at: Date.now() };
    return value;
  }

  /** Resolve the effective connection options for one call. */
  async options(input: CallOptions = {}): Promise<CallOptions & { distro: string }> {
    await this.initialized;
    const current = this.settings;
    const distro =
      input.distro ||
      current.distro ||
      (await this.distros()).find((item) => item.isDefault)?.name ||
      (await this.distros())[0]?.name;
    ensure(distro, 'NO_DISTRO', 'service.noDistro');
    const user =
      input.user ??
      (distro === current.distro || !current.distro
        ? current.user
        : (this.profiles.find((item) => item.distro === distro)?.user ?? ''));
    this.validateSettings({ distro, user });
    const directory =
      input.directory ??
      (environmentKey({ distro, user }) === environmentKey(current)
        ? current.directory
        : this.profile({ distro, user })?.directory) ??
      '';
    return {
      distro,
      user,
      directory,
      signal: input.signal,
      timeoutMs: input.rpcTimeoutMs ?? input.timeoutMs,
    };
  }

  /** Typed call to the worker that owns the resolved environment. */
  async call<M extends WorkerMethod>(
    target: BridgeTarget,
    method: M,
    params: WorkerParams<M>,
    options: CallOptions = {},
  ): Promise<WorkerResult<M>> {
    ensure(['wsl', 'windows', 'local'].includes(target), 'INVALID_TARGET', 'service.invalidTarget');
    const remote =
      target === 'wsl'
        ? await this.options(options)
        : { ...options, timeoutMs: options.rpcTimeoutMs ?? options.timeoutMs };
    return this.pool.call(target, method, params, remote);
  }

  /** Call a worker method whose name is assembled at runtime. */
  async callRaw(
    target: BridgeTarget,
    method: string,
    params: unknown = {},
    options: CallOptions = {},
  ): Promise<unknown> {
    ensure(['wsl', 'windows', 'local'].includes(target), 'INVALID_TARGET', 'service.invalidTarget');
    const remote =
      target === 'wsl'
        ? await this.options(options)
        : { ...options, timeoutMs: options.rpcTimeoutMs ?? options.timeoutMs };
    return this.pool.callRaw(target, method, params, remote);
  }

  /** Full status for the panel, CLI and tests. */
  async status(): Promise<ServiceStatus> {
    await this.initialized;
    let distros: DistroInfo[] = [];
    let error: string | null = this.settingsError ?? null;
    try {
      distros = await this.distros();
    } catch (failure) {
      error = (failure as Error).message;
    }
    return {
      version: PLUGIN_VERSION,
      host: process.platform,
      mode:
        process.platform === 'win32' ? 'windows-host' : process.env.WSL_DISTRO_NAME ? 'wsl-host' : 'unsupported',
      node: process.version,
      locale: getLocale(),
      locales: LOCALES,
      settings: this.settings,
      preferences: this.preferences,
      profiles: this.profiles,
      distros,
      pool: this.pool.snapshot(),
      permissions: this.permissions.snapshot(),
      error,
    };
  }

  /** Worker identity check used to validate a connection. */
  async ping(target: BridgeTarget = 'wsl', options: CallOptions = {}): Promise<WorkerInfo> {
    return this.call(target, 'ping', {}, options);
  }

  /** Convert a path with the distribution's own wslpath. */
  async convert(
    value: string,
    direction: 'linux' | 'windows',
    options: CallOptions = {},
  ): Promise<{ path: string }> {
    ensure(['linux', 'windows'].includes(direction), 'INVALID_ARGUMENT', 'service.invalidDirection');
    const resolved = await this.options(options);
    const unc = parseWslUnc(value);
    if (unc) {
      ensure(
        unc.distro.toLowerCase() === (resolved.distro as string).toLowerCase(),
        'DISTRO_MISMATCH',
        'paths.distroMismatch',
      );
    }
    if (direction === 'linux' && value.startsWith('/')) return { path: linuxPath(value) };
    if (direction === 'linux' && unc) return { path: unc.path };
    const key = JSON.stringify([resolved.distro, resolved.user, value, direction]);
    const cached = this.pathCache.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const result = await this.pool.call('wsl', 'path.convert', { path: value, direction }, resolved);
    if (this.pathCache.size > 256) this.pathCache.clear();
    this.pathCache.set(key, { value: result, at: Date.now() });
    return result;
  }

  private async normalized(target: BridgeTarget, value: string, options: CallOptions): Promise<string> {
    if (target === 'wsl') return (await this.convert(value, 'linux', options)).path;
    return value.startsWith('/') ? (await this.convert(value, 'windows', options)).path : value;
  }

  private async pinned(target: BridgeTarget, value: string | undefined, options: CallOptions): Promise<CallOptions> {
    return target === 'wsl' || value?.startsWith('/') ? this.options(options) : { ...options };
  }

  /** Run one foreground command in the target system. */
  async execute(target: BridgeTarget, input: ExecArgs, options: CallOptions = {}): Promise<ProcessResult> {
    const pinned = await this.pinned(target, input.cwd, options);
    integer(input.timeoutMs, 120000, 1, 86400000, 'timeoutMs');
    const cwd = input.cwd
      ? await this.normalized(target, input.cwd, pinned)
      : target === 'wsl'
        ? (pinned.directory || undefined)
        : undefined;
    return this.call(target, 'exec', { ...input, cwd }, {
      ...pinned,
      rpcTimeoutMs: (input.timeoutMs ?? 120000) + 10000,
    });
  }

  /** File operation routed to the system that owns the path. */
  async files(
    target: BridgeTarget,
    operation: 'read' | 'write' | 'list' | 'stat',
    input: FileArgs,
    options: CallOptions = {},
  ): Promise<FileReadResult | TransferCommitResult | FileStatResult | { path: string; entries: unknown[]; nextOffset: number | null }> {
    ensure(
      ['read', 'write', 'list', 'stat'].includes(operation),
      'INVALID_ARGUMENT',
      'service.invalidFileOperation',
    );
    const pinned = await this.pinned(target, input.path, options);
    const normalized = await this.normalized(target, input.path, pinned);
    return this.callRaw(target, `file.${operation}`, { ...input, path: normalized }, pinned) as Promise<
      FileReadResult | TransferCommitResult | FileStatResult | { path: string; entries: unknown[]; nextOffset: number | null }
    >;
  }

  /** Windows shell surface: open a target or move clipboard text. */
  async windows(
    input: { action: WindowsAction; target?: string; text?: string },
    options: CallOptions = {},
  ): Promise<WorkerResult<'windows.action'>> {
    const pinned = await this.pinned('windows', input.target, options);
    const payload =
      input.action === 'open' && input.target && !/^https?:\/\//i.test(input.target)
        ? { ...input, target: await this.normalized('windows', input.target, pinned) }
        : input;
    return this.call('windows', 'windows.action', payload, pinned);
  }

  /** Background job operations pinned to the environment that owns the job. */
  async job(
    target: BridgeTarget,
    action: 'start' | 'status' | 'cancel' | 'forget',
    input: ExecArgs & { id?: string },
    options: CallOptions = {},
  ): Promise<unknown> {
    ensure(['start', 'status', 'cancel', 'forget'].includes(action), 'INVALID_ARGUMENT', 'service.unknownJobAction');
    const owner = action === 'start' ? undefined : this.jobs.get(input.id ?? '');
    if (owner) {
      ensure(
        target === owner.target &&
          (!options.distro || options.distro === owner.distro) &&
          (options.user === undefined || options.user === owner.user),
        'JOB_ENVIRONMENT_MISMATCH',
        'service.jobEnvironmentMismatch',
      );
    }
    const pinned = owner ? { ...owner, signal: options.signal } : await this.pinned(target, input.cwd, options);
    if (action === 'start') {
      const payload: ExecArgs = {
        ...input,
        cwd: input.cwd
          ? await this.normalized(target, input.cwd, pinned)
          : target === 'wsl'
            ? (pinned.directory || undefined)
            : undefined,
      };
      const result = await this.call(target, 'job.start', payload, pinned);
      this.jobs.set(result.id, {
        target: target as 'wsl' | 'windows',
        distro: pinned.distro ?? '',
        user: pinned.user ?? '',
        directory: pinned.directory ?? '',
      });
      return { ...result, target, distro: pinned.distro, user: pinned.user };
    }
    ensure(typeof input.id === 'string' && input.id.length > 0, 'INVALID_ARGUMENT', 'errors.forbiddenValue', {
      name: 'id',
    });
    const id = input.id;
    if (action === 'status') return this.call(target, 'job.status', { id }, pinned) as Promise<JobStatusResult>;
    if (action === 'cancel') return this.call(target, 'job.cancel', { id }, pinned);
    const result = await this.call(target, 'job.forget', { id }, pinned);
    this.jobs.delete(id);
    return result;
  }

  /** Chunked cross-system file copy with SHA-256 verification and atomic commit. */
  async copy(input: {
    from: 'windows' | 'wsl';
    to: 'windows' | 'wsl';
    source: string;
    destination: string;
    expectedHash?: string;
    distro?: string;
    user?: string;
    signal?: AbortSignal;
    onProgress?: (progress: { bytes: number; totalBytes: number }) => void;
  }): Promise<TransferCommitResult> {
    ensure(
      ['windows', 'wsl'].includes(input.from) && ['windows', 'wsl'].includes(input.to),
      'INVALID_TARGET',
      'service.invalidCopyTargets',
    );
    const options = await this.options({
      distro: input.distro,
      user: input.user,
      signal: input.signal,
    });
    const source = await this.normalized(input.from, input.source, options);
    const destination = await this.normalized(input.to, input.destination, options);
    const before = await this.call(input.from, 'file.stat', { path: source }, options);
    ensure(before.bytes <= 1024 ** 3, 'FILE_TOO_LARGE', 'service.fileTooLarge');
    const destinationClient = await this.pool.get(
      input.to,
      ...(input.to === 'wsl' ? [options.distro, options.user] : []),
    );
    const transfer = await destinationClient.call(
      'transfer.begin',
      { path: destination, expectedHash: input.expectedHash ?? 'absent' },
      { signal: input.signal },
    );
    const hash = createHash('sha256');
    let offset = 0;
    try {
      while (offset < before.bytes) {
        aborted(input.signal);
        const chunk = await this.call(
          input.from,
          'file.read',
          { path: source, offset, limit: 262144, encoding: 'base64' },
          options,
        );
        ensure(
          chunk.bytes > 0 && chunk.totalBytes === before.bytes && chunk.mtimeMs === before.mtimeMs,
          'SOURCE_CHANGED',
          'service.sourceChanged',
        );
        hash.update(Buffer.from(chunk.content, 'base64'));
        await destinationClient.call(
          'transfer.chunk',
          { id: transfer.id, offset, data: chunk.content },
          { signal: input.signal },
        );
        offset += chunk.bytes;
        input.onProgress?.({ bytes: offset, totalBytes: before.bytes });
      }
      const after = await this.call(input.from, 'file.stat', { path: source }, options);
      ensure(
        after.bytes === before.bytes && after.mtimeMs === before.mtimeMs,
        'SOURCE_CHANGED',
        'service.sourceChanged',
      );
      return await destinationClient.call(
        'transfer.commit',
        { id: transfer.id, sha256: hash.digest('hex') },
        { signal: input.signal },
      );
    } catch (error) {
      await destinationClient
        .call('transfer.abort', { id: transfer.id }, { timeoutMs: 5000 })
        .catch(() => {});
      throw error;
    }
  }

  /** Release the pool when this service owns it. */
  async close(): Promise<void> {
    if (!this.ownsPool) return;
    await this.changes;
    await this.pool.close();
  }
}

/** Re-export the bridge error for callers that only import the service. */
export { BridgeError };
