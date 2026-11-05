import fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runProcess, powershellArgs, powershellPath, psLiteral } from './process.js';
import { serve } from './rpc.js';
import { BridgeError, ensure, text, integer, aborted, errorData } from './errors.js';
import { decodeChunk, type FileEncoding } from './encoding.js';
import { t } from './i18n/index.js';
import type {
  DirectoryEntry,
  ExecutionParams,
  FileReadResult,
  FileStatResult,
  JobStatusResult,
  StorageKind,
  TransferCommitResult,
  WorkerHandlers,
  WorkerInfo,
} from './worker-protocol.js';
import type { ProcessResult } from './process.js';

const transfers = new Map<string, TransferState>();
const jobs = new Map<string, JobRecord>();
const locks = new Set<string>();
const leases = new Map<string, { file: string; handle: fs.FileHandle }>();
const win = process.platform === 'win32';

/** In-flight atomic write shared by `file.write` and `transfer.*`. */
interface TransferState {
  target: string;
  temp: string;
  handle: fs.FileHandle;
  size: number;
  hash: ReturnType<typeof createHash>;
  expectedHash: string | undefined;
  timer: NodeJS.Timeout;
  busy: boolean;
}

/** One background job owned by this worker process. */
interface JobRecord {
  id: string;
  controller: AbortController;
  startedAt: number;
  status: JobStatusResult['status'];
  stdout: string;
  stderr: string;
  promise: Promise<void>;
  result?: ProcessResult;
  error?: { code: string; message: string };
  finishedAt?: number;
}

/** Validate and normalize an absolute path for the current operating system. */
function absolute(value: unknown): string {
  text(value, 'path');
  const candidate = value as string;
  ensure(
    path.isAbsolute(candidate) && (!win || /^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/i.test(candidate)),
    'INVALID_PATH',
    'worker.absolutePath',
  );
  if (win) {
    ensure(
      !/^\\\\[?.]\\/.test(candidate) && !candidate.slice(2).includes(':'),
      'INVALID_PATH',
      'worker.invalidWindowsPath',
    );
  }
  return path.normalize(candidate);
}

/** Resolve a readable regular file through every symbolic link. */
async function regular(value: unknown): Promise<{ path: string; stat: Stats }> {
  const resolved = await fs.realpath(absolute(value));
  const stat = (await fs.stat(resolved)) as Stats;
  ensure(stat.isFile(), 'NOT_FILE', 'worker.notFile');
  return { path: resolved, stat };
}

/** Resolve a write target without silently replacing a dangling symlink. */
async function targetPath(value: unknown): Promise<string> {
  const full = absolute(value);
  try {
    const resolved = await fs.realpath(full);
    ensure((await fs.stat(resolved)).isFile(), 'NOT_FILE', 'worker.targetNotFile');
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink must not be silently replaced with a regular file.
    try {
      const stat = await fs.lstat(full);
      ensure(!stat.isSymbolicLink(), 'DANGLING_SYMLINK', 'worker.danglingSymlink');
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner;
    }
    return path.join(await fs.realpath(path.dirname(full)), path.basename(full));
  }
}

/** SHA-256 of one file, cooperative with cancellation. */
async function digest(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    aborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Enforce the optional expected hash before replacing a file. */
async function checkExpected(file: string, expected: string | undefined, signal?: AbortSignal): Promise<void> {
  if (expected === undefined) return;
  ensure(
    expected === 'absent' || /^[a-f0-9]{64}$/i.test(expected),
    'INVALID_ARGUMENT',
    'worker.expectedHash',
  );
  let exists = true;
  let value: string | undefined;
  try {
    value = await digest(file, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  ensure(
    expected === 'absent' ? !exists : value === expected.toLowerCase(),
    'FILE_CONFLICT',
    'worker.fileConflict',
  );
}

/** Abort one transfer and remove every temporary artifact it created. */
async function abortTransfer(id: string): Promise<void> {
  const transfer = transfers.get(id);
  if (!transfer) return;
  transfers.delete(id);
  clearTimeout(transfer.timer);
  await transfer.handle.close().catch(() => {});
  await fs.unlink(transfer.temp).catch(() => {});
  locks.delete(transfer.target);
}

/** Begin an atomic write into a fresh temporary file next to the target. */
async function beginTransfer(
  input: { path: string; expectedHash?: string },
  signal?: AbortSignal,
): Promise<{ id: string; path: string }> {
  aborted(signal);
  ensure(transfers.size < 8, 'BUSY', 'worker.transferLimit');
  const target = await targetPath(input.path);
  ensure(!locks.has(target), 'FILE_BUSY', 'worker.targetBusy');
  locks.add(target);
  let temp: string | undefined;
  let handle: fs.FileHandle | undefined;
  try {
    await checkExpected(target, input.expectedHash, signal);
    const id = randomUUID();
    temp = path.join(path.dirname(target), `.dsh-wsl-${id}.tmp`);
    let mode = 0o600;
    try {
      mode = (await fs.stat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    handle = await fs.open(temp, 'wx', mode);
    const timer = setTimeout(() => {
      void abortTransfer(id);
    }, 300000);
    timer.unref();
    transfers.set(id, {
      target,
      temp,
      handle,
      size: 0,
      hash: createHash('sha256'),
      expectedHash: input.expectedHash,
      timer,
      busy: false,
    });
    return { id, path: target };
  } catch (error) {
    locks.delete(target);
    await handle?.close().catch(() => {});
    if (temp) await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Append one Base64 chunk at the exact expected offset. */
async function chunkTransfer(
  input: { id: string; offset: number; data: string },
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  const transfer = transfers.get(input.id);
  ensure(transfer && !transfer.busy, 'INVALID_TRANSFER', 'worker.transferMissing');
  const state = transfer as TransferState;
  aborted(signal);
  ensure(input.offset === state.size, 'OFFSET_MISMATCH', 'worker.offsetMismatch');
  ensure(
    typeof input.data === 'string' &&
      input.data.length <= 350000 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data),
    'INVALID_ARGUMENT',
    'worker.invalidChunk',
  );
  const data = Buffer.from(input.data, 'base64');
  ensure(state.size + data.length <= 1024 ** 3, 'FILE_TOO_LARGE', 'worker.sizeLimit');
  state.busy = true;
  try {
    let offset = 0;
    while (offset < data.length) {
      aborted(signal);
      const { bytesWritten } = await state.handle.write(data, offset, data.length - offset, state.size + offset);
      ensure(bytesWritten > 0, 'WRITE_FAILED', 'worker.writeFailed');
      offset += bytesWritten;
    }
    state.hash.update(data);
    state.size += data.length;
    state.timer.refresh();
    return { bytes: state.size };
  } catch (error) {
    await abortTransfer(input.id);
    throw error;
  } finally {
    state.busy = false;
  }
}

/** Verify the transfer hash and atomically replace the target. */
async function commitTransfer(
  input: { id: string; sha256: string },
  signal?: AbortSignal,
): Promise<TransferCommitResult> {
  const transfer = transfers.get(input.id);
  ensure(transfer && !transfer.busy, 'INVALID_TRANSFER', 'worker.transferWriting');
  const state = transfer as TransferState;
  state.busy = true;
  try {
    aborted(signal);
    const hash = state.hash.digest('hex');
    ensure(hash === input.sha256, 'HASH_MISMATCH', 'worker.hashMismatch');
    await state.handle.sync();
    await state.handle.close();
    await checkExpected(state.target, state.expectedHash, signal);
    aborted(signal);
    await fs.rename(state.temp, state.target);
    transfers.delete(input.id);
    clearTimeout(state.timer);
    locks.delete(state.target);
    return { path: state.target, bytes: state.size, sha256: hash };
  } catch (error) {
    await abortTransfer(input.id);
    throw error;
  }
}

/** Execute one command with explicit cwd/env and no shared shell state. */
async function execution(
  input: ExecutionParams,
  signal?: AbortSignal,
  onOutput?: (key: 'stdout' | 'stderr', chunk: Buffer) => void,
): Promise<ProcessResult> {
  ensure(
    (input.command !== undefined) !== (input.executable !== undefined),
    'INVALID_ARGUMENT',
    'worker.commandOrExecutable',
  );
  const cwd = input.cwd ? absolute(input.cwd) : os.homedir();
  let file: string;
  let args: string[];
  let scriptFile: string | undefined;
  if (input.command !== undefined) {
    text(input.command, 'command', 262144);
    file = win ? powershellPath() : '/bin/bash';
    if (win && input.command.length > 8000) {
      scriptFile = path.join(os.tmpdir(), `dsh-wsl-command-${randomUUID()}.ps1`);
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptFile];
    } else {
      args = win ? powershellArgs(input.command) : ['-lc', input.command];
    }
  } else {
    file = text(input.executable, 'executable');
    args = input.args ?? [];
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (input.env !== undefined) {
    ensure(
      input.env && typeof input.env === 'object' && !Array.isArray(input.env) && Object.keys(input.env).length <= 64,
      'INVALID_ARGUMENT',
      'worker.invalidEnv',
    );
    for (const [key, value] of Object.entries(input.env)) {
      ensure(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'),
        'INVALID_ARGUMENT',
        'worker.invalidEnv',
      );
      env[key] = value;
    }
  }
  const timeoutMs = integer(input.timeoutMs, 120000, 0, 86400000, 'timeoutMs');
  try {
    if (scriptFile) {
      await fs.writeFile(
        scriptFile,
        '\uFEFF' +
          "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;\n" +
          input.command,
        { flag: 'wx', mode: 0o600 },
      );
    }
    return await runProcess(file, args, {
      cwd,
      env,
      signal,
      timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      stdin: input.stdin,
      onOutput,
    });
  } finally {
    if (scriptFile) await fs.unlink(scriptFile).catch(() => {});
  }
}

/** Windows shell surface, restricted to the three supported actions. */
async function windowsAction(
  input: { action: 'open' | 'clipboard_get' | 'clipboard_set'; target?: string; text?: string },
  signal?: AbortSignal,
): Promise<ProcessResult | { text: string; truncated: boolean } | { bytes: number }> {
  ensure(win, 'WRONG_HOST', 'worker.wrongHost');
  if (input.action === 'open') {
    const target = text(input.target, 'target');
    let value = target;
    if (/^https?:\/\//i.test(target)) {
      const url = new URL(target);
      ensure(!url.username && !url.password, 'INVALID_URL', 'worker.invalidUrl');
      value = url.href;
    } else {
      value = absolute(target);
      await fs.access(value);
    }
    return runProcess(powershellPath(), powershellArgs(`Start-Process -FilePath ${psLiteral(value)}`), {
      signal,
      timeoutMs: 15000,
    });
  }
  if (input.action === 'clipboard_get') {
    const result = await runProcess(powershellPath(), powershellArgs('[Console]::Write((Get-Clipboard -Raw))'), {
      signal,
      timeoutMs: 10000,
      maxOutputBytes: 262144,
    });
    if (result.exitCode !== 0) {
      throw new BridgeError('CLIPBOARD_FAILED', t('worker.clipboardFailed', { error: result.stderr }));
    }
    return { text: result.stdout, truncated: result.truncated };
  }
  ensure(
    typeof input.text === 'string' && Buffer.byteLength(input.text) <= 262144,
    'INVALID_ARGUMENT',
    'worker.clipboardLimit',
  );
  const encoded = Buffer.from(input.text).toString('base64');
  const result = await runProcess(
    powershellPath(),
    powershellArgs(
      'Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))',
    ),
    { signal, timeoutMs: 10000, stdin: encoded },
  );
  if (result.exitCode !== 0) {
    throw new BridgeError('CLIPBOARD_FAILED', t('worker.clipboardFailed', { error: result.stderr }));
  }
  return { bytes: Buffer.byteLength(input.text) };
}

const handlers: WorkerHandlers = {
  'lease.acquire': async (input) => {
    const file = absolute(input.path);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BridgeError('RUNTIME_BUSY', t('worker.leaseBusy', { file }));
      }
      throw error;
    }
    const id = randomUUID();
    leases.set(id, { file, handle });
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return { id };
  },
  'lease.release': async (input) => {
    const lease = leases.get(input.id);
    if (!lease) return { released: true };
    leases.delete(input.id);
    await lease.handle.close();
    await fs.unlink(lease.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return { released: true };
  },
  ping: async (): Promise<WorkerInfo> => ({
    platform: process.platform,
    pid: process.pid,
    node: process.version,
    user: os.userInfo().username,
    home: os.homedir(),
    distro: process.env.WSL_DISTRO_NAME ?? null,
    arch: process.arch,
    uptime: process.uptime(),
  }),
  'directory.resolve': async (input, signal) => {
    aborted(signal);
    const resolved = await fs.realpath(absolute(input.path));
    const stat = await fs.stat(resolved);
    ensure(stat.isDirectory(), 'ENOTDIR', 'worker.directoryIsFile');
    const directory = await fs.opendir(resolved);
    await directory.close();
    const filesystem = await fs.statfs(resolved).catch(() => null);
    const filesystemType = filesystem ? Number(filesystem.type) : -1;
    // Linux V9FS_MAGIC identifies WSL's Windows-mounted 9P volumes.
    const storage: StorageKind = win
      ? 'windows'
      : filesystemType === 0x01021997
        ? 'windows-mount'
        : [0xef53, 0x01021994].includes(filesystemType)
          ? 'linux'
          : 'other';
    return { path: resolved, storage };
  },
  'directory.create': async (input, signal) => {
    aborted(signal);
    ensure(
      typeof input.name === 'string' &&
        input.name.trim() === input.name &&
        input.name.length > 0 &&
        Buffer.byteLength(input.name) <= 255 &&
        !['.', '..'].includes(input.name) &&
        !/[\\/\x00-\x1f]/.test(input.name),
      'INVALID_ARGUMENT',
      'worker.directoryName',
    );
    const parent = await fs.realpath(absolute(input.parent));
    const destination = path.join(parent, input.name);
    await fs.mkdir(destination);
    return { path: destination };
  },
  exec: (input, signal) => execution(input, signal),
  'path.convert': async (input, signal) => {
    ensure(!win, 'WRONG_HOST', 'worker.wrongHost');
    ensure(['linux', 'windows'].includes(input.direction), 'INVALID_ARGUMENT', 'service.invalidDirection');
    const result = await runProcess(
      'wslpath',
      [input.direction === 'linux' ? '-u' : '-w', '-a', text(input.path, 'path')],
      { signal, timeoutMs: 10000 },
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw new BridgeError('PATH_CONVERSION_FAILED', t('worker.pathConversionFailed', { error: result.stderr }));
    }
    return { path: result.stdout.replace(/[\r\n]+$/, '') };
  },
  'file.stat': async (input, signal): Promise<FileStatResult> => {
    const item = await regular(input.path);
    return {
      path: item.path,
      bytes: item.stat.size,
      mtimeMs: item.stat.mtimeMs,
      ...(input.hash ? { sha256: await digest(item.path, signal) } : {}),
    };
  },
  'file.list': async (input, signal) => {
    const directory = await fs.opendir(absolute(input.path));
    const entries: DirectoryEntry[] = [];
    const offset = integer(input.offset, 0, 0, 1000000, 'offset');
    const limit = integer(input.limit, 200, 1, 1000, 'limit');
    let index = 0;
    let nextOffset: number | null = null;
    for await (const entry of directory) {
      aborted(signal);
      if (!input.hidden && entry.name.startsWith('.')) continue;
      if (index++ < offset) continue;
      if (entries.length === limit) {
        nextOffset = offset + limit;
        break;
      }
      entries.push({
        name: entry.name,
        type: entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : entry.isFile()
              ? 'file'
              : 'other',
      });
    }
    return { path: input.path, entries, nextOffset };
  },
  'file.read': async (input, signal): Promise<FileReadResult> => {
    aborted(signal);
    const item = await regular(input.path);
    const offset = integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = integer(input.limit, 65536, 1, 262144, 'limit');
    const handle = await fs.open(item.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(limit, Math.max(0, item.stat.size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      aborted(signal);
      const data = buffer.subarray(0, bytesRead);
      const encoding = (input.encoding ?? 'utf8') as FileEncoding;
      ensure(['utf8', 'gb18030', 'base64'].includes(encoding), 'INVALID_ARGUMENT', 'worker.invalidEncoding');
      const decoded = decodeChunk(data, encoding, offset + bytesRead >= item.stat.size);
      return {
        path: item.path,
        ...decoded,
        encoding,
        nextOffset: offset + decoded.bytes,
        totalBytes: item.stat.size,
        eof: offset + decoded.bytes >= item.stat.size,
        mtimeMs: item.stat.mtimeMs,
      };
    } finally {
      await handle.close();
    }
  },
  'file.write': async (input, signal) => {
    ensure(
      typeof input.content === 'string' && Buffer.byteLength(input.content) <= 524288,
      'INVALID_ARGUMENT',
      'worker.writeLimit',
    );
    const data = Buffer.from(input.content);
    const transfer = await beginTransfer(input, signal);
    try {
      for (let i = 0; i < data.length; i += 262144) {
        await chunkTransfer(
          { id: transfer.id, offset: i, data: data.subarray(i, i + 262144).toString('base64') },
          signal,
        );
      }
      return await commitTransfer(
        { id: transfer.id, sha256: createHash('sha256').update(data).digest('hex') },
        signal,
      );
    } catch (error) {
      await abortTransfer(transfer.id);
      throw error;
    }
  },
  'transfer.begin': (input, signal) => beginTransfer(input, signal),
  'transfer.chunk': (input, signal) => chunkTransfer(input, signal),
  'transfer.commit': (input, signal) => commitTransfer(input, signal),
  'transfer.abort': async (input) => {
    await abortTransfer(input.id);
    return { aborted: true };
  },
  'job.start': async (input) => {
    for (const [id, job] of jobs) {
      if (job.finishedAt && Date.now() - job.finishedAt > 300000) jobs.delete(id);
    }
    ensure(jobs.size < 32, 'BUSY', 'worker.jobLimit');
    const id = randomUUID();
    const controller = new AbortController();
    const job: JobRecord = {
      id,
      controller,
      startedAt: Date.now(),
      status: 'running',
      stdout: '',
      stderr: '',
      promise: Promise.resolve(),
    };
    jobs.set(id, job);
    job.promise = execution(input, controller.signal, (key, chunk) => {
      job[key] = (job[key] + chunk.toString('utf8')).slice(-32768);
    })
      .then(
        (result) => {
          job.result = result;
          job.status = result.cancelled
            ? 'cancelled'
            : result.timedOut
              ? 'timed-out'
              : result.exitCode === 0
                ? 'completed'
                : 'failed';
        },
        (error: unknown) => {
          job.error = errorData(error);
          job.status = 'failed';
        },
      )
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return { id, status: 'running' as const };
  },
  'job.status': async (input): Promise<JobStatusResult> => {
    const job = jobs.get(input.id);
    ensure(job, 'JOB_NOT_FOUND', 'worker.jobNotFound');
    const found = job as JobRecord;
    return {
      id: found.id,
      status: found.status,
      startedAt: found.startedAt,
      stdout: found.stdout,
      stderr: found.stderr,
      result: found.result ?? null,
      error: found.error ?? null,
    };
  },
  'job.cancel': async (input) => {
    const job = jobs.get(input.id);
    ensure(job, 'JOB_NOT_FOUND', 'worker.jobNotFound');
    (job as JobRecord).controller.abort();
    await (job as JobRecord).promise;
    return { id: (job as JobRecord).id, status: (job as JobRecord).status };
  },
  'job.forget': async (input) => {
    const job = jobs.get(input.id);
    ensure(job && (job as JobRecord).status !== 'running', 'JOB_RUNNING', 'worker.jobRunning');
    jobs.delete(input.id);
    return { removed: true };
  },
  'windows.action': (input, signal) => windowsAction(input, signal),
};

const info = await handlers.ping({}, new AbortController().signal);
const shutdown = await serve(handlers as unknown as Record<string, (params: unknown, signal: AbortSignal) => Promise<unknown>>, {
  info,
  dispose: async () => {
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...jobs.values()].map((job) => job.promise));
    await Promise.allSettled([...transfers.keys()].map(abortTransfer));
    await Promise.allSettled([...leases.keys()].map((id) => handlers['lease.release']({ id }, new AbortController().signal)));
  },
});
for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(event, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
