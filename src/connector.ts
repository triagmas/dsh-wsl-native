import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { RpcClient, type RpcCallOptions } from './rpc.js';
import { BridgeError, ensure, text } from './errors.js';
import { distroName, parseDistros, shellQuote, type DistroInfo } from './paths.js';
import { t } from './i18n/index.js';
import type { WorkerInfo, WorkerMethod, WorkerParams, WorkerResult } from './worker-protocol.js';

/** Targets the plugin can drive. */
export type BridgeTarget = 'wsl' | 'windows' | 'local';

/** Connection settings shared by every bridge. */
export interface ConnectOptions {
  target?: BridgeTarget;
  distro?: string;
  user?: string;
  windowsNode?: string;
  linuxNode?: string;
}

/**
 * Bootstrap injected through stdin before any RPC byte.
 *
 * The first line carries the bundled worker; no runtime is installed in the
 * target distribution. Later RPC bytes are put back on stdin before importing
 * the worker, avoiding a lost-first-request race.
 */
export const BOOTSTRAP = `let b=Buffer.alloc(0);process.stdin.on('data',function boot(c){b=Buffer.concat([b,c]);const n=b.indexOf(10);if(n<0){if(b.length>524288)process.exit(65);return}process.stdin.off('data',boot);process.stdin.pause();const rest=b.subarray(n+1);if(rest.length)process.stdin.unshift(rest);const src=b.subarray(0,n).toString();import('data:text/javascript;base64,'+src).then(()=>process.stdin.resume()).catch(e=>{process.stderr.write(e.stack+'\\n');process.exit(1)})});`;

/** Candidate locations of the bundled worker, in resolution order. */
export function resolveWorkerFile(): string {
  const override = process.env.DSH_WSL_WORKER;
  if (override && fs.existsSync(override)) return override;
  const candidates = ['./worker.js', '../dist/worker.js', '../../dist/worker.js', '../lib/worker.mjs'];
  for (const candidate of candidates) {
    const file = fileURLToPath(new URL(candidate, import.meta.url));
    if (fs.existsSync(file)) return file;
  }
  throw new BridgeError(
    'WORKER_MISSING',
    `worker bundle not found next to ${fileURLToPath(import.meta.url)}; run npm run build`,
  );
}

/** Absolute path of `wsl.exe` on the Windows host. */
export function wslExecutable(): string {
  return process.env.SystemRoot
    ? path.win32.join(process.env.SystemRoot, 'System32', 'wsl.exe')
    : 'wsl.exe';
}

/** `execFile` wrapper that keeps raw bytes and reports stderr on failure. */
export function execFileBuffer(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1048576,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stderrText: (stderr as Buffer | undefined)?.toString('utf8').slice(-2048),
            }),
          );
          return;
        }
        resolve({ stdout: stdout as Buffer, stderr: stderr as Buffer });
      },
    );
  });
}

/** Enumerate installed WSL distributions; a WSL host reports only itself. */
export async function listDistros(): Promise<DistroInfo[]> {
  if (process.platform !== 'win32') {
    return process.env.WSL_DISTRO_NAME
      ? [{ name: process.env.WSL_DISTRO_NAME, state: 'Running', version: 2, isDefault: true }]
      : [];
  }
  const { stdout } = await execFileBuffer(wslExecutable(), ['--list', '--verbose']);
  return parseDistros(stdout);
}

/**
 * Start one resident worker and wait for its readiness frame.
 *
 * Every branch spawns the same Node bootstrap: a local process, `wsl.exe`
 * for a distribution, or `node.exe` through Windows interop. The transport is
 * stdin/stdout only; no port is opened.
 */
export async function connect(options: ConnectOptions = {}): Promise<RpcClient> {
  const { target, distro, user, windowsNode, linuxNode } = options;
  let file: string;
  let args: string[];
  if (
    target === 'local' ||
    (target === 'windows' && process.platform === 'win32') ||
    (target === 'wsl' &&
      process.platform === 'linux' &&
      (!distro || distro === process.env.WSL_DISTRO_NAME))
  ) {
    ensure(
      target !== 'wsl' || process.env.WSL_DISTRO_NAME,
      'NOT_WSL',
      'connector.notWsl',
    );
    ensure(
      target !== 'wsl' ||
        process.platform === 'win32' ||
        !user ||
        user === os.userInfo().username,
      'USER_MISMATCH',
      'connector.userMismatch',
    );
    file = process.execPath;
    args = ['-e', BOOTSTRAP];
  } else if (target === 'wsl') {
    ensure(process.platform === 'win32', 'WRONG_HOST', 'connector.wrongHost');
    if (distro) distroName(distro);
    if (user) {
      text(user, 'user', 128);
      ensure(
        !user.startsWith('-') && !/[\r\n]/.test(user),
        'INVALID_ARGUMENT',
        'connector.invalidUser',
      );
    }
    const nodeCommand = linuxNode ? shellQuote(text(linuxNode, 'linuxNode')) : 'node';
    const script = `command -v ${nodeCommand} >/dev/null 2>&1 || { echo ${shellQuote(t('connector.linuxNodeMissing'))} >&2; exit 69; }; exec ${nodeCommand} -e ${shellQuote(BOOTSTRAP)} 1>&3 3>&-`;
    // User login profiles may print banners. Reserve stdout for RPC before running them.
    const outer = `exec 3>&1; exec 1>&2; exec bash -lc ${shellQuote(script)}`;
    file = wslExecutable();
    args = [
      ...(distro ? ['--distribution', distro] : []),
      ...(user ? ['--user', user] : []),
      '--cd',
      '~',
      '--exec',
      'bash',
      '-c',
      outer,
    ];
  } else if (target === 'windows') {
    ensure(
      process.platform === 'linux' && !!process.env.WSL_DISTRO_NAME,
      'NOT_WSL',
      'connector.notWsl',
    );
    file = windowsNode || process.env.DSH_WSL_WINDOWS_NODE || 'node.exe';
    args = ['-e', BOOTSTRAP];
  } else {
    throw new BridgeError('INVALID_TARGET', t('connector.invalidTarget'));
  }
  const source = (await fsp.readFile(resolveWorkerFile())).toString('base64') + '\n';
  const child = spawn(file, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: process.platform === 'win32' ? process.env.SystemRoot : undefined,
  });
  const rpc = new RpcClient(child);
  child.stdin?.write(source, (error) => {
    if (error) rpc.fail(error);
  });
  const info = await rpc.ready;
  try {
    ensure(
      target !== 'wsl' || info.platform === 'linux',
      'WRONG_RUNTIME',
      'connector.wrongRuntimeWsl',
    );
    ensure(
      target !== 'windows' || info.platform === 'win32',
      'WRONG_RUNTIME',
      'connector.wrongRuntimeWindows',
    );
  } catch (error) {
    await rpc.close();
    throw error;
  }
  return rpc;
}

/** Pool snapshot exposed to the panel diagnostics. */
export interface PoolSnapshot {
  starts: number;
  connections: {
    target: [string, string, string];
    connected: boolean;
    pending: number;
    info: WorkerInfo | null;
  }[];
}

interface PoolEntry {
  active: number;
  touched: number;
  rpc?: RpcClient;
  promise?: Promise<RpcClient>;
}

/**
 * Resident-worker pool keyed by `[target, distro, user]`.
 * Concurrent requests share one first connection; disconnect never replays an
 * in-flight request because a write or command may already have executed.
 */
export class ConnectionPool {
  readonly config: ConnectOptions;
  readonly entries = new Map<string, PoolEntry>();
  closed = false;
  starts = 0;

  constructor(config: ConnectOptions = {}) {
    this.config = config;
  }

  async get(target: BridgeTarget, distro?: string, user?: string): Promise<RpcClient> {
    ensure(!this.closed, 'CONNECTION_CLOSED', 'connector.pluginStopped');
    let keyDistro = distro;
    let keyUser = user;
    if (target !== 'wsl') {
      keyDistro = undefined;
      keyUser = undefined;
    }
    const key = JSON.stringify([target, keyDistro ?? '', keyUser ?? '']);
    let entry = this.entries.get(key);
    if (entry?.rpc?.isClosed) {
      this.entries.delete(key);
      entry = undefined;
    }
    // The default user and their explicit name share the same resident worker.
    if (!entry && target === 'wsl' && keyUser) {
      entry = [...this.entries.entries()].find(([candidate, value]) => {
        const identity = JSON.parse(candidate) as [string, string, string];
        return (
          identity[0] === 'wsl' &&
          identity[1] === keyDistro &&
          value.rpc &&
          !value.rpc.isClosed &&
          value.rpc.worker?.user === keyUser
        );
      })?.[1];
    }
    if (!entry) {
      ensure(this.entries.size < 8, 'POOL_FULL', 'connector.poolFull');
      entry = { active: 0, touched: Date.now() };
      this.entries.set(key, entry);
      this.starts++;
      entry.promise = connect({ ...this.config, target, distro: keyDistro, user: keyUser })
        .then((rpc) => {
          entry!.rpc = rpc;
          return rpc;
        })
        .catch((error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        });
    }
    entry.touched = Date.now();
    return entry.promise as Promise<RpcClient>;
  }

  /** Typed call through the pool; the connection key comes from the options. */
  async call<M extends WorkerMethod>(
    target: BridgeTarget,
    method: M,
    params: WorkerParams<M>,
    options: RpcCallOptions & { distro?: string; user?: string } = {},
  ): Promise<WorkerResult<M>> {
    const rpc = await this.get(target, options.distro, options.user);
    return rpc.call(method, params, options);
  }

  /** Call a method name assembled at runtime. */
  async callRaw(
    target: BridgeTarget,
    method: string,
    params: unknown = {},
    options: RpcCallOptions & { distro?: string; user?: string } = {},
  ): Promise<unknown> {
    const rpc = await this.get(target, options.distro, options.user);
    return rpc.callRaw(method, params, options);
  }

  snapshot(): PoolSnapshot {
    return {
      starts: this.starts,
      connections: [...this.entries.entries()].map(([key, value]) => ({
        target: JSON.parse(key) as [string, string, string],
        connected: !!value.rpc && !value.rpc.isClosed,
        pending: value.rpc?.pendingCount ?? 0,
        info: value.rpc?.worker ?? null,
      })),
    };
  }

  async disconnect(): Promise<void> {
    const items = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      items.map(async (entry) => (await entry.promise)?.close()),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.disconnect();
  }
}
