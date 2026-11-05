import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { BridgeError, ensure, aborted } from './errors.js';
import { shellQuote } from './paths.js';
import { prepareWindowsCache } from './install-cache.js';
import { waitForLocalhost } from './localhost.js';
import { appOrigin } from './handoff.js';
import { ProfileInheritance } from './inheritance.js';
import { t } from './i18n/index.js';
import type { JobStatusResult, FileReadResult, WorkerInfo } from './worker-protocol.js';
import type { ProcessResult, ProcessResult as RunResult } from './process.js';
import type { CallOptions, WslService } from './service.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** DSH release this build is verified against. */
export const DSH_VERSION = '0.2.1-rc.5';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Paths of one prepared Linux environment. */
export interface NativeLocations {
  base: string;
  runtime: string;
  dshHome: string;
  patch: string;
  cli: string;
  node: string;
  distro: string;
}

/** Locations plus the installed plugin snapshot. */
export interface PreparedRuntime extends NativeLocations {
  plugin: string;
  version: string;
}

/** A launcher lease held by the running environment. */
export interface Lease {
  id: string;
}

/** The Linux DSH instance started by this launcher. */
export interface RunningRuntime {
  id: string;
  url: string;
  distro: string;
  user: string;
  dshHome: string;
  lease: Lease | null;
  startedAt: number;
}

/** Resolution steps reported to the panel and CLI. */
export interface LauncherProgress {
  phase: 'idle' | 'copying' | 'downloading' | 'installing' | 'inheriting' | 'ready' | 'failed';
  text: string;
  base?: string;
  runtime?: string;
  dshHome?: string;
  patch?: string;
  cli?: string;
  node?: string;
  distro?: string;
}

/** Options accepted by `prepare`. */
export interface PrepareOptions {
  distro?: string;
  signal?: AbortSignal;
  onProgress?: (progress: LauncherProgress) => void;
  npmCache?: string;
  installNetwork?: 'auto' | 'windows' | 'linux';
  reinstall?: boolean;
}

/** Options accepted by `start`. */
export interface StartOptions {
  distro?: string;
  cwd?: string;
  port?: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  parentOrigin?: string | null;
}

/** Files copied into the Linux snapshot, relative to the plugin root. */
const SNAPSHOT_FILES = ['package.json', 'cordis.patch.yml'] as const;

/** Locate every self-contained bundle that must exist in the snapshot. */
async function snapshotSources(): Promise<{ name: string; content: string }[]> {
  const files: string[] = [...SNAPSHOT_FILES];
  const entries = await fs.readdir(path.join(packageRoot, 'dist'));
  for (const name of entries) if (name.endsWith('.js')) files.push(`dist/${name}`);
  return Promise.all(
    files.map(async (name) => ({ name, content: await fs.readFile(path.join(packageRoot, name), 'utf8') })),
  );
}

/** Explain a nonzero setup command without hiding its output. */
function setupFailure(result: RunResult): BridgeError {
  return new BridgeError('SETUP_FAILED', t('launcher.setupFailed', { error: result.stderr || result.stdout }));
}

/**
 * Prepares and runs the Linux DSH installation.
 *
 * Everything is written below the Linux installation directory. The Windows
 * profile is only read, and no global npm, WSL or firewall configuration is
 * touched: the Windows npm cache is reused because it is content-addressed.
 */
export class NativeLauncher {
  private readonly service: WslService;
  /** Runtime started by this launcher; `null` when stopped. */
  running: RunningRuntime | null = null;
  /** In-flight preparation, shared by concurrent callers. */
  preparing: Promise<PreparedRuntime> | null = null;
  private readonly lifecycle = new AbortController();
  /** Per-session secret used to sign handoff links. */
  readonly handoffSecret = randomBytes(32).toString('hex');
  progress: LauncherProgress = { phase: 'idle', text: '' };
  readonly inheritance: ProfileInheritance;

  constructor(service: WslService) {
    this.service = service;
    this.inheritance = new ProfileInheritance(service);
  }

  private async lease(loc: NativeLocations, distro: string, signal?: AbortSignal): Promise<Lease> {
    const mkdir = await this.service.execute(
      'wsl',
      { executable: 'mkdir', args: ['-p', '--', loc.base], cwd: '/', timeoutMs: 15000 },
      { distro, signal },
    );
    ensure(mkdir.exitCode === 0, 'SETUP_FAILED', 'launcher.setupFailed', { error: mkdir.stderr });
    return (await this.service.call('wsl', 'lease.acquire', { path: `${loc.base}/runtime.lock` }, { distro, signal })) as Lease;
  }

  private async release(lease: Lease | null | undefined, distro: string): Promise<void> {
    if (!lease) return;
    await this.service.call('wsl', 'lease.release', { id: lease.id }, { distro }).catch(() => {});
  }

  /** Stop the managed runtime and wait for in-flight preparation. */
  async close(): Promise<void> {
    this.lifecycle.abort();
    await this.preparing?.catch(() => {});
    await this.stop().catch(() => {});
  }

  /** The managed process is still owned by this launcher and still running. */
  async getRunning(): Promise<RunningRuntime | null> {
    if (!this.running) return null;
    const alive = this.service.pool
      .snapshot()
      .connections.some(
        (connection) =>
          connection.connected &&
          connection.target[0] === 'wsl' &&
          connection.target[1] === this.running?.distro &&
          (!this.service.settings.user || connection.info?.user === this.service.settings.user),
      );
    const job = alive
      ? ((await this.service.job('wsl', 'status', { id: this.running.id }).catch(() => null)) as JobStatusResult | null)
      : null;
    if (job?.status === 'running') return this.running;
    if (alive) await this.release(this.running.lease, this.running.distro);
    this.running = null;
    return null;
  }

  /** Resolve and validate the Linux installation layout. */
  async locations(distro?: string): Promise<NativeLocations> {
    const info: WorkerInfo = await this.service.ping('wsl', { distro });
    const [major, minor] = info.node.replace(/^v/, '').split('.').map(Number) as [number, number];
    ensure(major >= 24 || (major === 22 && minor >= 19), 'NODE_VERSION', 'launcher.nodeVersion');
    const base = this.service.config.nativeRoot || `${info.home}/.local/share/dsh-wsl-native`;
    ensure(base.startsWith('/') && !base.includes('\0'), 'INVALID_ARGUMENT', 'launcher.invalidNativeRoot');
    return {
      base,
      runtime: `${base}/runtime`,
      dshHome: `${base}/dsh-home`,
      patch: `${base}/runtime/plugin.patch.json`,
      cli: `${base}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`,
      node: this.service.config.linuxNode || 'node',
      distro: info.distro ?? '',
    };
  }

  /** Poll one background job, cancelling it when the caller aborts. */
  async jobUntilDone(
    id: string,
    options: { distro: string; signal?: AbortSignal },
    onProgress?: (log: string) => void,
  ): Promise<ProcessResult | null> {
    for (;;) {
      if (options.signal?.aborted) {
        await this.service.job('wsl', 'cancel', { id }, { distro: options.distro });
        aborted(options.signal);
      }
      const job = (await this.service.job('wsl', 'status', { id }, { distro: options.distro })) as JobStatusResult;
      onProgress?.((job.stdout + '\n' + job.stderr).slice(-8192));
      if (job.status !== 'running') {
        await this.service.job('wsl', 'forget', { id }, { distro: options.distro });
        if (job.status !== 'completed') {
          throw setupFailure(
            job.result ??
              {
                stdout: job.stdout,
                stderr: job.error?.message || job.stderr || t('launcher.installTaskFailed', { status: job.status }),
              } as RunResult,
          );
        }
        return job.result;
      }
      await sleep(500);
    }
  }

  /** Install or repair the Linux runtime and the plugin snapshot. */
  async prepare(options: PrepareOptions = {}): Promise<PreparedRuntime> {
    ensure(!this.preparing, 'SETUP_BUSY', 'launcher.setupBusy');
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    let npmCache = options.npmCache;
    const installNetwork = options.installNetwork ?? 'auto';
    ensure(
      ['auto', 'windows', 'linux'].includes(installNetwork),
      'INVALID_ARGUMENT',
      'launcher.invalidInstallNetwork',
    );
    const report = (progress: LauncherProgress): void => {
      this.progress = progress;
      options.onProgress?.(progress);
    };
    const work = async (): Promise<PreparedRuntime> => {
      report({ phase: 'copying', text: t('launcher.progress.copying') });
      const loc = await this.locations(options.distro);
      const lease = await this.lease(loc, loc.distro, signal);
      try {
        const contents = await snapshotSources();
        const hash = createHash('sha256');
        for (const file of contents) hash.update(file.name).update(file.content);
        const snapshot = `${loc.runtime}/plugins/${hash.digest('hex').slice(0, 20)}`;
        const mk = await this.service.execute(
          'wsl',
          {
            executable: 'mkdir',
            args: ['-p', '--', loc.runtime, `${snapshot}/dist`],
            timeoutMs: 15000,
          },
          { distro: loc.distro, signal },
        );
        if (mk.exitCode !== 0) throw setupFailure(mk);
        let copied = false;
        try {
          copied =
            (
              (await this.service.files(
                'wsl',
                'read',
                { path: `${snapshot}/.complete` },
                { distro: loc.distro, signal },
              )) as FileReadResult
            ).content === 'ready';
        } catch {
          // A partial snapshot is repaired below.
        }
        if (!copied) {
          for (const file of contents) {
            aborted(signal);
            await this.service.files(
              'wsl',
              'write',
              { path: `${snapshot}/${file.name}`, content: file.content },
              { distro: loc.distro, signal },
            );
          }
          await this.service.files(
            'wsl',
            'write',
            { path: `${snapshot}/.complete`, content: 'ready' },
            { distro: loc.distro, signal },
          );
        }
        let installed = false;
        try {
          installed =
            (
              JSON.parse(
                (
                  (await this.service.files(
                    'wsl',
                    'read',
                    { path: `${loc.runtime}/.dsh-wsl-ready.json` },
                    { distro: loc.distro, signal },
                  )) as FileReadResult
                ).content,
              ) as { version?: string }
            ).version === DSH_VERSION;
        } catch {
          installed = false;
        }
        if (!installed || options.reinstall) {
          if (!npmCache && process.platform === 'win32') {
            const cache = await this.service
              .execute('windows', { command: 'npm config get cache', timeoutMs: 15000 }, { signal })
              .catch(() => null);
            if (cache?.exitCode === 0 && /^[a-z]:[\\/][^\r\n]+$/i.test(cache.stdout.trim())) {
              npmCache = cache.stdout.trim();
            }
          }
          const assisted =
            installNetwork === 'windows' || (installNetwork === 'auto' && process.platform === 'win32');
          ensure(!assisted || (process.platform === 'win32' && npmCache), 'NPM_CACHE_REQUIRED', 'launcher.npmCacheRequired');
          const cacheArg = npmCache
            ? ` --cache ${shellQuote((await this.service.convert(npmCache, 'linux', { distro: loc.distro, signal })).path)}`
            : '';
          if (assisted) {
            report({ phase: 'downloading', text: t('launcher.progress.downloading') });
            const info = await this.service.ping('wsl', { distro: loc.distro });
            const cached = await prepareWindowsCache({
              version: DSH_VERSION,
              arch: info.arch,
              cache: npmCache as string,
              signal,
              onProgress: (text) => report({ phase: 'downloading', text }),
            });
            await this.service.files(
              'wsl',
              'write',
              { path: `${loc.runtime}/package.json`, content: cached.packageJson },
              { distro: loc.distro, signal },
            );
            await this.service.files(
              'wsl',
              'write',
              { path: `${loc.runtime}/package-lock.json`, content: cached.lockText },
              { distro: loc.distro, signal },
            );
          }
          report({
            phase: 'installing',
            text: t('launcher.progress.installing', { version: DSH_VERSION, runtime: loc.runtime }),
          });
          const install = assisted
            ? `npm ci --offline --no-audit --no-fund${cacheArg}`
            : `npm install --no-audit --no-fund --fetch-retries=1 --fetch-timeout=15000 --save-exact${cacheArg} ${shellQuote(`@deepseek-ai/dsh@${DSH_VERSION}`)}`;
          const script = `set -e\ncd ${shellQuote(loc.runtime)}\n${shellQuote(loc.node)} -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!(a>=24||(a===22&&b>=19)))throw Error("DSH requires Node 22.19+ or 24+")'\n${install}`;
          const job = (await this.service.job(
            'wsl',
            'start',
            { command: script, cwd: loc.runtime, timeoutMs: 1800000 },
            { distro: loc.distro, signal },
          )) as { id: string };
          await this.jobUntilDone(job.id, { distro: loc.distro, signal }, (log) =>
            report({ phase: 'installing', text: log }),
          );
          await this.service.files(
            'wsl',
            'write',
            { path: `${loc.runtime}/.dsh-wsl-ready.json`, content: JSON.stringify({ version: DSH_VERSION }) },
            { distro: loc.distro, signal },
          );
        }
        const entry = new URL('file:///');
        entry.pathname = `${snapshot}/dist/index.js`;
        const patch =
          JSON.stringify([{ insert: [{ id: 'dsh-wsl-native', name: entry.href }] }], null, 2) + '\n';
        await this.service.files('wsl', 'write', { path: loc.patch, content: patch }, { distro: loc.distro, signal });
        await this.inheritance.apply(loc, {
          distro: loc.distro,
          signal,
          npmCache,
          onProgress: (text) => report({ phase: 'inheriting', text }),
          jobUntilDone: this.jobUntilDone.bind(this),
        });
        report({ phase: 'ready', text: t('launcher.progress.ready'), ...loc });
        return { ...loc, plugin: snapshot, version: DSH_VERSION };
      } finally {
        await this.release(lease, loc.distro);
      }
    };
    this.preparing = work();
    try {
      return await this.preparing;
    } catch (error) {
      report({ phase: 'failed', text: (error as Error).message });
      throw error;
    } finally {
      this.preparing = null;
    }
  }

  /** Start the Linux DSH web view and verify the Windows-facing localhost path. */
  async start(options: StartOptions = {}): Promise<RunningRuntime> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    const { distro, cwd, port = 0 } = options;
    if (this.running) {
      const job = (await this.service
        .job('wsl', 'status', { id: this.running.id }, { distro: this.running.distro })
        .catch(() => null)) as JobStatusResult | null;
      if (job?.status === 'running') {
        ensure(
          !distro || this.running.distro === distro,
          'ALREADY_RUNNING',
          'launcher.alreadyRunning',
        );
        return this.running;
      }
      await this.release(this.running.lease, this.running.distro);
      this.running = null;
    }
    const loc = await this.locations(distro);
    try {
      await this.service.files('wsl', 'stat', { path: loc.cli }, { distro: loc.distro, signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeError('SETUP_REQUIRED', t('launcher.setupRequired', { distro: loc.distro }));
      }
      throw error;
    }
    ensure(
      Number.isSafeInteger(port) && port >= 0 && port <= 65535,
      'INVALID_ARGUMENT',
      'launcher.invalidPort',
    );
    const env: Record<string, string> = {
      DSH_HOME: loc.dshHome,
      DSH_WSL_HANDOFF_SECRET: this.handoffSecret,
    };
    const origin = appOrigin(options.parentOrigin);
    if (origin) env.DSH_WSL_PARENT_ORIGIN = origin;
    if (cwd) env.DSH_WSL_DIRECTORY = cwd;
    if (process.platform === 'win32') {
      env.DSH_WSL_WINDOWS_NODE = (
        await this.service.convert(process.execPath, 'linux', { distro: loc.distro })
      ).path;
    } else if (process.env.DSH_WSL_WINDOWS_NODE) {
      env.DSH_WSL_WINDOWS_NODE = process.env.DSH_WSL_WINDOWS_NODE;
    }
    await this.service.files('wsl', 'stat', { path: loc.patch }, { distro: loc.distro, signal }).catch(() => {
      throw new BridgeError('SETUP_REQUIRED', 'launcher.patchMissing');
    });
    const lease = await this.lease(loc, loc.distro, signal);
    let job: { id: string } | undefined;
    try {
      job = (await this.service.job(
        'wsl',
        'start',
        {
          executable: loc.node,
          args: [loc.cli, 'web', '--patch', loc.patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
          cwd: cwd || undefined,
          env,
          timeoutMs: 0,
        },
        { distro: loc.distro, signal },
      )) as { id: string };
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        aborted(signal);
        const status = (await this.service.job(
          'wsl',
          'status',
          { id: job.id },
          { distro: loc.distro },
        )) as JobStatusResult;
        options.onProgress?.(
          (status.stdout + '\n' + status.stderr)
            .replace(/([?&](?:token|auth|key)=[^\s&]+)/gi, '?[redacted]')
            .slice(-4096),
        );
        if (status.status !== 'running') {
          throw new BridgeError(
            'DSH_START_FAILED',
            status.error?.message || status.result?.stderr || status.stderr || t('launcher.dshExited'),
          );
        }
        const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+[^\s]*)/.exec(status.stdout);
        if (match) {
          const url = new URL(match[1] as string);
          ensure(url.hostname === '127.0.0.1' && url.port, 'INVALID_URL', 'launcher.invalidUrl');
          // Native DSH announces readiness after its startup audit; also verify the Windows-facing path.
          const reachable = await waitForLocalhost(url.href, { signal });
          ensure(reachable, 'LOCALHOST_UNREACHABLE', 'launcher.localhostUnreachable');
          await this.service.files(
            'wsl',
            'write',
            { path: `${loc.runtime}/.dsh-wsl-ready.json`, content: JSON.stringify({ version: DSH_VERSION }) },
            { distro: loc.distro, signal },
          );
          this.running = {
            id: job.id,
            url: url.href,
            distro: loc.distro,
            user: this.service.settings.user,
            dshHome: loc.dshHome,
            lease,
            startedAt: Date.now(),
          };
          return this.running;
        }
        await sleep(500);
      }
      throw new BridgeError('DSH_START_TIMEOUT', t('launcher.dshStartTimeout'));
    } catch (error) {
      if (job) await this.service.job('wsl', 'cancel', { id: job.id }, { distro: loc.distro }).catch(() => {});
      await this.release(lease, loc.distro);
      throw error;
    }
  }

  /** Stop the managed runtime, if any. */
  async stop(): Promise<{ stopped: true }> {
    if (!this.running) return { stopped: true };
    const current = this.running;
    this.running = null;
    try {
      await this.service.job('wsl', 'cancel', { id: current.id }, { distro: current.distro });
      await this.service.job('wsl', 'forget', { id: current.id }, { distro: current.distro });
    } finally {
      await this.release(current.lease, current.distro);
    }
    return { stopped: true };
  }
}

export type { CallOptions };
