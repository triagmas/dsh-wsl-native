import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { BridgeError, aborted, ensure, integer, text } from './errors.js';
import { t } from './i18n/index.js';

/** Options accepted by {@link runProcess}. */
export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Text written to stdin before it is closed. */
  stdin?: string;
  /** Streaming hook receiving every chunk, including output beyond the retained cap. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
}

/** Completed process outcome; `timedOut` and `cancelled` are both terminal. */
export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  outputBytes: { stdout: number; stderr: number };
  durationMs: number;
}

/** Terminate a child and its descendants, best effort, without blocking the caller forever. */
export async function killTree(child: ChildProcess, graceMs = 250): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`,
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* The process may already be gone. */
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* The process group is already reaped. */
  }
}

/**
 * Run one program with a bounded retained-output budget while still draining
 * both streams, so a noisy child cannot grow the chat result without bound.
 */
export async function runProcess(
  file: string,
  args: string[] = [],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  text(file, 'executable');
  ensure(
    Array.isArray(args) && args.every((x) => typeof x === 'string' && !x.includes('\0')),
    'INVALID_ARGUMENT',
    'process.argsArray',
  );
  aborted(options.signal);
  const timeoutMs = integer(options.timeoutMs, 120000, 0, 86400000, 'timeoutMs');
  const maxOutputBytes = integer(options.maxOutputBytes, 65536, 256, 1048576, 'maxOutputBytes');
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let cancelled = false;
    let closing: Promise<void> | undefined;
    let spawnError: Error | undefined;
    const buffers: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const received = { stdout: 0, stderr: 0 };
    const retained = { stdout: 0, stderr: 0 };
    const collect =
      (key: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        received[key] += chunk.length;
        const keep = Math.min(chunk.length, maxOutputBytes - retained[key]);
        if (keep > 0) {
          buffers[key].push(chunk.subarray(0, keep));
          retained[key] += keep;
        }
        options.onOutput?.(key, chunk);
      };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.stdin?.on('error', () => {
      /* The child may exit before reading stdin. */
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    const stop = (): void => {
      closing ??= killTree(child);
    };
    const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const cancel = (): void => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdin?.end(options.stdin ?? '');
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      void (async () => {
        await closing;
        if (spawnError) {
          reject(spawnError);
          return;
        }
        const decode = (key: 'stdout' | 'stderr'): string => {
          const decoder = new StringDecoder('utf8');
          const value = decoder.write(Buffer.concat(buffers[key]));
          return value + (received[key] > retained[key] ? '' : decoder.end());
        };
        resolve({
          exitCode,
          signal,
          stdout: decode('stdout'),
          stderr: decode('stderr'),
          timedOut,
          cancelled,
          truncated: received.stdout > retained.stdout || received.stderr > retained.stderr,
          outputBytes: received,
          durationMs: Math.round((performance.now() - start) * 100) / 100,
        });
      })();
    });
  });
}

/** PowerShell invocation that forces UTF-8 output and a strict error preference. */
export function powershellArgs(script: string): string[] {
  text(script, 'script', 262144);
  const prefix =
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ";
  const encoded = Buffer.from(prefix + script, 'utf16le').toString('base64');
  if (encoded.length >= 30000) {
    throw new BridgeError('COMMAND_TOO_LONG', t('process.commandTooLong'));
  }
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

/** Absolute path of Windows PowerShell 5.1. */
export function powershellPath(): string {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** Quote a value as a PowerShell single-quoted literal. */
export function psLiteral(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}
