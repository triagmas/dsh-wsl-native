import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { BridgeError, aborted, ensure } from './errors.js';
import { t } from './i18n/index.js';
import {
  PROTOCOL_VERSION,
  type CancelFrame,
  type ReadyFrame,
  type ResponseFrame,
  type WorkerInfo,
  type WorkerMethod,
  type WorkerParams,
  type WorkerResult,
} from './worker-protocol.js';

/** Largest accepted JSON frame on the bridge. */
export const MAX_FRAME = 2097152;
/** Protocol version re-exported for tests and connectors. */
export const PROTOCOL = PROTOCOL_VERSION;

/** Options for one RPC call. */
export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Callback invoked for every parsed frame; the frame is untrusted JSON. */
export type FrameListener = (frame: unknown) => void;

/**
 * Incremental newline-delimited JSON reader. Frames are bounded, malformed
 * input fails the whole stream (and therefore the connection), and partial
 * multi-byte sequences are handled by buffering bytes rather than text.
 */
export function readFrames(stream: Readable, onFrame: FrameListener, onError: (error: Error) => void): () => void {
  let pending = Buffer.alloc(0);
  let failed = false;
  const fail = (error: Error): void => {
    if (failed) return;
    failed = true;
    onError(error);
  };
  const data = (chunk: Buffer | string): void => {
    if (failed) return;
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > MAX_FRAME) {
        fail(new BridgeError('FRAME_TOO_LARGE', t('rpc.frameTooLarge')));
        return;
      }
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (!line.length) continue;
      try {
        onFrame(JSON.parse(line.toString('utf8')));
      } catch (error) {
        fail(new BridgeError('INVALID_FRAME', t('rpc.invalidFrame', { error: (error as Error).message })));
        return;
      }
    }
    if (pending.length > MAX_FRAME) fail(new BridgeError('FRAME_TOO_LARGE', t('rpc.frameTooLarge')));
  };
  stream.on('data', data);
  return () => stream.off('data', data);
}

/** Write one newline-terminated JSON frame, rejecting on a closed or full stream. */
export async function writeFrame(stream: Writable, value: unknown): Promise<void> {
  const frame = JSON.stringify(value) + '\n';
  ensure(Buffer.byteLength(frame) <= MAX_FRAME, 'FRAME_TOO_LARGE', 'rpc.frameTooLarge');
  ensure(!stream.destroyed && !stream.writableEnded, 'CONNECTION_CLOSED', 'rpc.connectionClosed');
  ensure(stream.writableLength < 4 * MAX_FRAME, 'BACKPRESSURE', 'rpc.backpressure');
  return new Promise<void>((resolve, reject) => {
    stream.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * Host-side handle for one resident worker process.
 *
 * A failed bootstrap, a closed stdin, an exited process or an oversized frame
 * fails every pending call exactly once; requests are never replayed because an
 * interrupted write or command may already have executed.
 */
export class RpcClient {
  readonly child: ChildProcess;
  readonly ready: Promise<WorkerInfo>;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 0;
  private closed = false;
  private stderrText = '';
  private info: WorkerInfo | undefined;
  private readonly startupTimer: NodeJS.Timeout;
  private readonly unread: () => void;
  private readyResolve: (info: WorkerInfo) => void = () => {};
  private readyReject: (error: Error) => void = () => {};

  constructor(child: ChildProcess, options: { startupMs?: number; onExit?: () => void } = {}) {
    this.child = child;
    this.ready = new Promise<WorkerInfo>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A bootstrap failure may precede the caller awaiting `ready`.
    this.ready.catch(() => {});
    this.startupTimer = setTimeout(
      () => this.fail(new BridgeError('START_TIMEOUT', t('rpc.startTimeout'))),
      options.startupMs ?? 20000,
    );
    this.unread = readFrames(
      child.stdout as Readable,
      (message) => this.receive(message),
      (error) => this.fail(error),
    );
    child.stderr?.on('data', (data: Buffer) => {
      this.stderrText = (this.stderrText + data.toString(data.includes(0) ? 'utf16le' : 'utf8')).slice(-8192);
    });
    child.stdin?.on('error', (error) => this.fail(error));
    child.once('error', (error) => this.fail(error));
    child.once('close', () => {
      this.fail(
        new BridgeError(
          'CONNECTION_CLOSED',
          t('rpc.bridgeExited', { stderr: this.stderrText.trim() }),
        ),
      );
      options.onExit?.();
    });
  }

  /** Worker identity reported at bootstrap, once available. */
  get worker(): WorkerInfo | undefined {
    return this.info;
  }

  /** Number of calls awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Whether this connection can no longer serve calls. */
  get isClosed(): boolean {
    return this.closed;
  }

  private receive(message: unknown): void {
    const frame = message as Partial<ReadyFrame & ResponseFrame>;
    if (frame?.event === 'ready') {
      ensure(frame.protocol === PROTOCOL, 'PROTOCOL_MISMATCH', 'rpc.protocolMismatch');
      clearTimeout(this.startupTimer);
      this.info = frame.info as WorkerInfo;
      this.readyResolve(this.info);
      return;
    }
    if (!Number.isSafeInteger(frame?.id)) {
      throw new BridgeError('INVALID_FRAME', t('rpc.invalidResponse'));
    }
    const entry = this.pending.get(frame.id as number);
    if (!entry) return;
    this.pending.delete(frame.id as number);
    entry.cleanup();
    if (frame.error) entry.reject(new BridgeError(frame.error.code ?? 'BRIDGE_ERROR', frame.error.message ?? ''));
    else entry.resolve(frame.result);
  }

  /**
   * Call one worker method. `timeoutMs` cancels the worker-side operation and
   * waits for it to reach quiescence before failing the connection.
   */
  async call<M extends WorkerMethod>(
    method: M,
    params: WorkerParams<M>,
    options: RpcCallOptions = {},
  ): Promise<WorkerResult<M>> {
    return (await this.request(method, params, options)) as WorkerResult<M>;
  }

  /** Call a method name assembled at runtime (for example `file.${operation}`). */
  async callRaw(method: string, params: unknown = {}, options: RpcCallOptions = {}): Promise<unknown> {
    return this.request(method, params, options);
  }

  private async request(method: string, params: unknown, options: RpcCallOptions): Promise<unknown> {
    aborted(options.signal);
    await this.ready;
    aborted(options.signal);
    ensure(!this.closed, 'CONNECTION_CLOSED', 'rpc.connectionClosed');
    ensure(this.pending.size < 32, 'BUSY', 'rpc.busy');
    const id = ++this.nextId;
    const timeoutMs = options.timeoutMs ?? 130000;
    return new Promise<unknown>((resolve, reject) => {
      let cancelTimer: NodeJS.Timeout | undefined;
      const cancel = (): void => {
        const frame: CancelFrame = { method: '$cancel', params: { id } };
        void writeFrame(this.child.stdin as Writable, frame).catch((error) => this.fail(error));
        // Wait for the worker to kill the process tree before settling cancellation.
        cancelTimer ??= setTimeout(
          () => this.fail(new BridgeError('CANCEL_TIMEOUT', t('rpc.cancelTimeout'))),
          6000,
        );
      };
      const timer = setTimeout(cancel, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        if (cancelTimer) clearTimeout(cancelTimer);
        options.signal?.removeEventListener('abort', cancel);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener('abort', cancel, { once: true });
      void writeFrame(this.child.stdin as Writable, { id, method, params })
        .then(() => {
          if (options.signal?.aborted) cancel();
        })
        .catch((error) => this.fail(error));
    });
  }

  /** Fail the connection once, rejecting every pending call. */
  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.startupTimer);
    this.unread();
    this.readyReject(error);
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    this.pending.clear();
    // EOF lets the worker clean up its own children and temporary transfers.
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), 6500);
    timer.unref();
  }

  /** Gracefully stop the worker and wait for its exit. */
  async close(): Promise<void> {
    if (!this.closed) this.fail(new BridgeError('CONNECTION_CLOSED', t('rpc.connectionClosed')));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 7000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Options for {@link serve}. */
export interface ServeOptions {
  input?: Readable & { pause(): void; resume(): void };
  output?: Writable;
  info?: unknown;
  dispose?: () => Promise<void> | void;
}

/**
 * Worker-side request server. Each request runs in its own abortable task; the
 * server stops accepting work after EOF, an output error or a protocol failure,
 * aborts in-flight tasks and awaits their quiescence before disposing.
 */
export async function serve(
  handlers: Record<string, (params: unknown, signal: AbortSignal) => Promise<unknown> | unknown>,
  options: ServeOptions = {},
): Promise<() => Promise<void>> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lookup: Partial<
    Record<string, (params: unknown, signal: AbortSignal) => Promise<unknown> | unknown>
  > = handlers;
  const active = new Map<number, { controller: AbortController; promise: Promise<void> }>();
  let stopping = false;
  let unread: () => void = () => {};
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    unread();
    input.pause();
    for (const task of active.values()) task.controller.abort();
    await Promise.allSettled([...active.values()].map((task) => task.promise));
    await options.dispose?.();
  }
  output.on('error', () => {
    void shutdown();
  });
  unread = readFrames(
    input,
    (message) => {
      const frame = message as { id?: unknown; method?: unknown; params?: unknown };
      if (frame?.method === '$cancel') {
        const id = (frame.params as { id?: number } | undefined)?.id;
        if (typeof id === 'number') active.get(id)?.controller.abort();
        return;
      }
      if (stopping) return;
      try {
        ensure(
          Number.isSafeInteger(frame?.id) && (frame.id as number) > 0 && typeof frame.method === 'string',
          'INVALID_FRAME',
          'rpc.invalidRequest',
        );
        ensure(!active.has(frame.id as number), 'DUPLICATE_ID', 'rpc.duplicateId');
      } catch (error) {
        void shutdown();
        throw error;
      }
      const id = frame.id as number;
      const handler = lookup[frame.method as string];
      if (!handler || active.size >= 16) {
        void writeFrame(output, {
          id,
          error: {
            code: handler ? 'BUSY' : 'UNKNOWN_METHOD',
            message: handler ? t('rpc.tooManyRequests') : t('rpc.unknownMethod'),
          },
        }).catch(() => void shutdown());
        return;
      }
      const controller = new AbortController();
      const promise: Promise<void> = Promise.resolve()
        .then(() => handler(frame.params ?? {}, controller.signal))
        .then(
          (result) => ({ id, result }),
          (error: unknown) => ({
            id,
            error: {
              code:
                typeof (error as { code?: unknown })?.code === 'string'
                  ? (error as { code: string }).code
                  : 'BRIDGE_ERROR',
              message: String((error as Error)?.message ?? error).slice(0, 4096),
            },
          }),
        )
        .then((reply) => writeFrame(output, reply))
        .catch(() => {
          void shutdown();
        })
        .finally(() => active.delete(id));
      active.set(id, { controller, promise });
    },
    () => {
      void shutdown();
    },
  );
  input.once('end', () => void shutdown());
  input.once('error', () => void shutdown());
  await writeFrame(output, { event: 'ready', protocol: PROTOCOL, info: options.info });
  return shutdown;
}
