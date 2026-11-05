import { ct } from './i18n/client.js';

/** Recovery state attached to one environment entry. */
export interface RecoveryState {
  phase: 'waiting' | 'connecting' | 'failed';
  attempt: number;
  message: string;
}

/** Entry contract the recovery loop needs. */
export interface RecoverableEntry {
  key: string;
  recovery?: RecoveryState | null;
  ready?: boolean;
}

/** Options accepted by `createConnectionRecovery`. */
export interface RecoveryOptions<T extends RecoverableEntry> {
  retry(entry: T): Promise<void>;
  current(key: string): T | null;
  changed(): void;
  delays?: number[];
  stableMs?: number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Internal per-entry retry bookkeeping. */
interface EntryState {
  attempts: number;
  running?: boolean;
  failure?: unknown;
  timer?: ReturnType<typeof setTimeout> | null;
  stable?: ReturnType<typeof setTimeout> | null;
}

/**
 * Retries reconnect the page only. Business operations are never replayed here,
 * so a reconnect cannot duplicate a file write or a command.
 */
export function createConnectionRecovery<T extends RecoverableEntry>(options: RecoveryOptions<T>): {
  failed(entry: T, error: unknown, graceMs?: number): void;
  connected(entry: T): void;
  cancel(key: string): void;
  dispose(): void;
} {
  const {
    retry,
    current,
    changed,
    delays = [1500, 4000, 10000],
    stableMs = 60000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  const states = new Map<string, EntryState>();
  const valid = (entry: T): boolean => current(entry.key) === entry;

  function cancel(key: string): void {
    const state = states.get(key);
    if (!state) return;
    if (state.timer) clearTimer(state.timer);
    if (state.stable) clearTimer(state.stable);
    states.delete(key);
  }

  function failed(entry: T, error: unknown, graceMs = 0): void {
    if (!valid(entry)) return;
    let state = states.get(entry.key);
    if (!state) {
      state = { attempts: 0 };
      states.set(entry.key, state);
    }
    if (state.stable) {
      clearTimer(state.stable);
      state.stable = null;
    }
    if (state.running) {
      state.failure = error;
      return;
    }
    if (state.timer) return;
    if (state.attempts >= delays.length) {
      entry.recovery = { phase: 'failed', attempt: state.attempts, message: ct('client.recoveryFailed') };
      changed();
      return;
    }
    entry.recovery = { phase: 'waiting', attempt: state.attempts + 1, message: ct('client.reconnectingWsl') };
    state.timer = setTimer(() => {
      state.timer = null;
      if (states.get(entry.key) !== state || !valid(entry)) return;
      state.attempts += 1;
      state.running = true;
      state.failure = null;
      entry.recovery = { ...(entry.recovery ?? { attempt: state.attempts, message: '' }), phase: 'connecting' };
      changed();
      let failure: unknown;
      void (async () => {
        try {
          await retry(entry);
        } catch (reason) {
          failure = reason;
        } finally {
          state.running = false;
        }
        failure ??= state.failure;
        if (failure && states.get(entry.key) === state) {
          const next = current(entry.key);
          if (next) failed(next, failure);
        }
      })();
    }, Math.max(graceMs, delays[state.attempts] ?? 10000));
    changed();
  }

  function connected(entry: T): void {
    if (!valid(entry)) return;
    entry.recovery = null;
    const state = states.get(entry.key);
    if (!state) return;
    state.failure = undefined;
    if (state.timer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    if (!state.stable) state.stable = setTimer(() => cancel(entry.key), stableMs);
  }

  return {
    failed,
    connected,
    cancel,
    dispose() {
      for (const key of [...states.keys()]) cancel(key);
    },
  };
}
