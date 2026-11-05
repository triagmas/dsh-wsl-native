/**
 * The complete RPC contract between the plugin host and the resident worker.
 *
 * Both sides import these types, so a change to a request or response shape is
 * a compile error in the producer and every consumer instead of a runtime
 * surprise across the Windows/WSL boundary.
 */
import type { FileEncoding } from './encoding.js';
import type { ProcessResult } from './process.js';

/** Where a WSL directory physically lives. */
export type StorageKind = 'linux' | 'windows-mount' | 'other' | 'windows';

/** Identity reported by a worker once its bridge is ready. */
export interface WorkerInfo {
  platform: string;
  pid: number;
  node: string;
  user: string;
  home: string;
  distro: string | null;
  arch: string;
  uptime: number;
}

/** Environment variables accepted by one execution (bounded, validated). */
export type ExecutionEnv = Record<string, string>;

/** Arguments shared by `exec` and `job.start`. */
export interface ExecutionParams {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: ExecutionEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
}

/** One directory entry returned by `file.list`. */
export interface DirectoryEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
}

/** Result of `file.stat`. */
export interface FileStatResult {
  path: string;
  bytes: number;
  mtimeMs: number;
  sha256?: string;
}

/** One page of a file read. */
export interface FileReadResult {
  path: string;
  content: string;
  encoding: FileEncoding;
  bytes: number;
  nextOffset: number;
  totalBytes: number;
  eof: boolean;
  mtimeMs: number;
}

/** Result of a committed atomic write or transfer. */
export interface TransferCommitResult {
  path: string;
  bytes: number;
  sha256: string;
}

/** State of a background job as reported by the worker. */
export interface JobStatusResult {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
  startedAt: number;
  stdout: string;
  stderr: string;
  result: ProcessResult | null;
  error: { code: string; message: string } | null;
}

/** Windows shell surface actions permitted by the plugin. */
export type WindowsAction = 'open' | 'clipboard_get' | 'clipboard_set';

/** Request/response pairs for every worker method. */
export interface WorkerMethods {
  ping: { params: Record<string, never>; result: WorkerInfo };
  'directory.resolve': { params: { path: string }; result: { path: string; storage: StorageKind } };
  'directory.create': { params: { parent: string; name: string }; result: { path: string } };
  exec: { params: ExecutionParams; result: ProcessResult };
  'path.convert': {
    params: { path: string; direction: 'linux' | 'windows' };
    result: { path: string };
  };
  'file.stat': { params: { path: string; hash?: boolean }; result: FileStatResult };
  'file.list': {
    params: { path: string; offset?: number; limit?: number; hidden?: boolean };
    result: { path: string; entries: DirectoryEntry[]; nextOffset: number | null };
  };
  'file.read': {
    params: { path: string; offset?: number; limit?: number; encoding?: FileEncoding };
    result: FileReadResult;
  };
  'file.write': {
    params: { path: string; content: string; expectedHash?: string };
    result: TransferCommitResult;
  };
  'transfer.begin': { params: { path: string; expectedHash?: string }; result: { id: string; path: string } };
  'transfer.chunk': { params: { id: string; offset: number; data: string }; result: { bytes: number } };
  'transfer.commit': { params: { id: string; sha256: string }; result: TransferCommitResult };
  'transfer.abort': { params: { id: string }; result: { aborted: true } };
  'job.start': { params: ExecutionParams; result: { id: string; status: 'running' } };
  'job.status': { params: { id: string }; result: JobStatusResult };
  'job.cancel': { params: { id: string }; result: { id: string; status: string } };
  'job.forget': { params: { id: string }; result: { removed: true } };
  'lease.acquire': { params: { path: string }; result: { id: string } };
  'lease.release': { params: { id: string }; result: { released: true } };
  'windows.action': {
    params: { action: WindowsAction; target?: string; text?: string };
    result:
      | ProcessResult
      | { text: string; truncated: boolean }
      | { bytes: number };
  };
}

/** Every worker method name. */
export type WorkerMethod = keyof WorkerMethods;
/** Request parameters for one worker method. */
export type WorkerParams<M extends WorkerMethod> = WorkerMethods[M]['params'];
/** Response payload for one worker method. */
export type WorkerResult<M extends WorkerMethod> = WorkerMethods[M]['result'];

/** Handler map implemented by the worker. */
export type WorkerHandlers = {
  [M in WorkerMethod]: (
    params: WorkerParams<M>,
    signal: AbortSignal,
  ) => Promise<WorkerResult<M>> | WorkerResult<M>;
};

/** Frame carrying a bootstrap failure or readiness announcement. */
export interface ReadyFrame {
  event: 'ready';
  protocol: number;
  info: WorkerInfo;
}

/** Cancellation frame sent by the host for one in-flight request. */
export interface CancelFrame {
  method: '$cancel';
  params: { id: number };
}

/** Correlated response frame. */
export interface ResponseFrame {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Supported protocol version; a mismatch fails closed at startup. */
export const PROTOCOL_VERSION = 1;
