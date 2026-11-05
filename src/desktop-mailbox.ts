import { CONVERSATION_ACTIONS } from './workspace-commands.js';
import { ct } from './i18n/client.js';
import type { Catalog, GuestResult } from './client-types.js';

export const DESKTOP_MAILBOX = '__DSH_WSL_DESKTOP_V1__';

/** One sequenced signal delivered to the hosting panel. */
export interface MailboxSignal {
  sequence: number;
  type: 'return' | 'sidebar';
}

/** Snapshot returned by `next`. */
export interface MailboxSnapshot {
  sequence: number;
  closed: boolean;
  catalog: Catalog | null;
  signals: MailboxSignal[];
}

/** Callable command surface exposed to the Linux page. */
export interface MailboxApi {
  request(key: string, action: string, payload?: Record<string, unknown>): Promise<GuestResult>;
  next(key: string, after?: number): Promise<MailboxSnapshot>;
}

/** Mailbox created for one embedded page. */
export interface DesktopMailbox {
  api: Readonly<MailboxApi>;
  publish(type: string, payload: { catalog?: Catalog }): void;
  dispose(): void;
}

/**
 * A capability-scoped, change-driven mailbox inside the owned Linux webview.
 * It is installed only after the Linux host verifies the signed workspace handoff.
 */
export function createDesktopMailbox(
  channel: string,
  command: (action: string, payload: Record<string, unknown>) => Promise<unknown>,
  options: { waitMs?: number } = {},
): DesktopMailbox {
  const { waitMs = 20000 } = options;
  let sequence = 0;
  let catalogSequence = 0;
  let catalog: Catalog | null = null;
  let closed = false;
  let waiter: (() => void) | undefined;
  const signals: MailboxSignal[] = [];

  const authorize = (value: string): void => {
    if (closed || value !== channel) throw new Error(ct('client.invalidChannel'));
  };
  const snapshot = (after: number): MailboxSnapshot => ({
    sequence,
    closed,
    catalog: catalogSequence > after ? catalog : null,
    signals: signals.filter((item) => item.sequence > after),
  });
  const wake = (): void => waiter?.();

  return {
    api: Object.freeze({
      async request(key: string, action: string, payload: Record<string, unknown> = {}): Promise<GuestResult> {
        authorize(key);
        if (
          !CONVERSATION_ACTIONS.has(action) ||
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          JSON.stringify(payload).length > 131072
        ) {
          throw new Error(ct('client.invalidPageAction'));
        }
        try {
          const value = await command(action, payload);
          return value === undefined ? { ok: true } : { ok: true, value };
        } catch (error) {
          return { ok: false, error: String((error as Error).message || error).slice(0, 1000) };
        }
      },
      next(key: string, after = 0): Promise<MailboxSnapshot> {
        authorize(key);
        if (!Number.isSafeInteger(after) || after < 0 || after > sequence) throw new Error(ct('client.invalidCursor'));
        if (sequence > after) return Promise.resolve(snapshot(after));
        if (waiter) throw new Error(ct('client.pendingSubscription'));
        return new Promise((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            waiter = undefined;
            resolve(snapshot(after));
          };
          const timer = setTimeout(finish, waitMs);
          waiter = finish;
        });
      },
    }),
    publish(type: string, payload: { catalog?: Catalog }): void {
      if (closed) return;
      if (type === 'catalog' && payload.catalog) {
        catalog = payload.catalog;
        catalogSequence = ++sequence;
      } else if (type === 'return' || type === 'sidebar') {
        signals.push({ sequence: ++sequence, type });
        if (signals.length > 16) signals.shift();
      } else {
        return;
      }
      wake();
    },
    dispose(): void {
      closed = true;
      wake();
      signals.length = 0;
      catalog = null;
    },
  };
}
