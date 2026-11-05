import { localOrigin } from './handoff.js';
import { DESKTOP_MAILBOX } from './desktop-mailbox.js';
import { ct } from './i18n/client.js';
import type { Catalog, EnvironmentSettings } from './client-types.js';

/** Minimal surface of the Electron `<webview>` element this module uses. */
export interface WebviewElement extends HTMLElement {
  getURL(): string;
  loadURL(url: string): Promise<void>;
  executeJavaScript(source: string): Promise<unknown>;
}

/** Navigation message emitted by the hosting desktop shell. */
export interface ViewMessage {
  type: 'catalog';
  catalog: Catalog | null;
}

/** Error emitted when the embedded page leaves its verified environment. */
export type ViewError = Error;

/** Reservation returned by the desktop browser bridge. */
export interface LeaseReservation {
  lease: string;
  partition: string;
}

/** Isolated browser surface provided by the desktop host. */
export interface DesktopBridge {
  acquire(name: string): Promise<LeaseReservation>;
  release(lease: string): Promise<void>;
  onOpenRequested?(lease: string, listener: (url: string) => void): () => void;
}

/** One environment mounted in a desktop view. */
export interface ViewEntry {
  key: string;
  origin: string;
  channel: string;
  url: string;
  settings: EnvironmentSettings;
}

/** Options accepted by `mountDesktopView`. */
export interface MountOptions {
  host: HTMLElement;
  entry: ViewEntry;
  bridge: DesktopBridge;
  onMessage(message: ViewMessage): void;
  onError(error: ViewError): void;
  createElement?(): WebviewElement;
}

/** Adapter returned to the conversation model. */
export interface MountedView {
  request(action: string, payload: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
}

// These fixed calls target our own signed Linux plugin endpoint, never user-supplied JavaScript.
export function desktopCallSource(
  origin: string,
  channel: string,
  method: 'next' | 'request',
  args: unknown[],
): string {
  if (!localOrigin(origin) || !['next', 'request'].includes(method) || !/^[a-zA-Z0-9-]{32,64}$/.test(channel)) {
    throw new Error(ct('client.invalidChannelArgs'));
  }
  return `(() => { if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== '/') return null; const api = window[${JSON.stringify(DESKTOP_MAILBOX)}]; return api ? api[${JSON.stringify(method)}](...${JSON.stringify([channel, ...args])}) : null; })()`;
}

/** Mailbox snapshot as it arrives from the page. */
interface Snapshot {
  sequence: number;
  closed: boolean;
  catalog?: Catalog | null;
  signals?: { type: string }[];
}

/** Mount one embedded Linux DSH view with a change-driven mailbox. */
export function mountDesktopView(options: MountOptions): MountedView {
  const { host, entry, bridge, onMessage, onError, createElement = () => document.createElement('webview') as WebviewElement } = options;
  let disposed = false;
  let element: WebviewElement | undefined;
  let lease: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeDelay: (() => void) | undefined;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wakeDelay = resolve;
      timer = setTimeout(() => {
        wakeDelay = undefined;
        resolve();
      }, ms);
    });

  const invoke = (method: 'next' | 'request', ...args: unknown[]): Promise<unknown> => {
    if (disposed || !element) return Promise.reject(new Error(ct('client.pageNotConnected')));
    let origin: string;
    try {
      origin = new URL(element.getURL()).origin;
    } catch {
      return Promise.reject(new Error(ct('client.pageNotConnected')));
    }
    if (origin !== entry.origin) return Promise.reject(new Error(ct('client.pageNotConnected')));
    return element.executeJavaScript(desktopCallSource(entry.origin, entry.channel, method, args));
  };

  async function subscribe(current: number): Promise<void> {
    let sequence = 0;
    let until = Date.now() + 45000;
    try {
      while (!disposed && current === generation) {
        const message = (await invoke('next', sequence)) as Snapshot | null;
        if (disposed || current !== generation) return;
        if (!message) {
          if (Date.now() > until) throw new Error(ct('client.pluginNotReady'));
          await delay(250);
          continue;
        }
        if (message.closed) throw new Error(ct('client.mailboxClosed'));
        until = Date.now() + 45000;
        if (!Number.isSafeInteger(message.sequence) || message.sequence < sequence) {
          throw new Error(ct('client.pageReturnedCursor'));
        }
        sequence = message.sequence;
        if (message.catalog) onMessage({ type: 'catalog', catalog: message.catalog });
        for (const event of (message.signals ?? []).slice(0, 16)) {
          if (event.type === 'return' || event.type === 'sidebar') onMessage({ type: 'catalog', catalog: null });
        }
      }
    } catch (error) {
      if (!disposed && current === generation) onError(error as Error);
    }
  }

  const adapter: MountedView = {
    async request(action: string, payload: Record<string, unknown>): Promise<unknown> {
      const result = (await invoke('request', action, payload)) as { ok?: boolean; error?: string; value?: unknown } | null;
      if (!result?.ok) throw new Error(result?.error || ct('client.pageNotConnected'));
      return result.value;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      wakeDelay?.();
      unsubscribe?.();
      element?.remove();
      if (lease) void bridge.release(lease).catch(() => {});
    },
  };

  void (async () => {
    if (!bridge?.acquire || !bridge?.release) throw new Error(ct('client.noDesktopView'));
    const reservation = await bridge.acquire('dsh-wsl-native:' + entry.key);
    lease = reservation.lease;
    if (disposed) {
      await bridge.release(lease);
      return;
    }
    element = createElement();
    element.className = 'dsh-wsl-desktop-view';
    element.setAttribute('name', lease);
    element.setAttribute('partition', reservation.partition);
    element.setAttribute('allowpopups', '');
    element.setAttribute('aria-label', `WSL ${entry.settings.distro}`);
    element.setAttribute('src', 'about:blank#' + lease);
    let bootstrap = true;
    element.addEventListener('dom-ready', () => {
      if (disposed || !element) return;
      if (bootstrap) {
        bootstrap = false;
        void element.loadURL(entry.url).catch((error: Error) => {
          if (!disposed) onError(error);
        });
      } else {
        void subscribe(++generation);
      }
    });
    element.addEventListener('did-start-navigation', (event) => {
      const navigation = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
      if (navigation.isMainFrame && !navigation.isInPlace) generation += 1;
    });
    element.addEventListener('did-fail-load', (event) => {
      const failure = event as Event & { isMainFrame?: boolean; errorCode?: number };
      if (!disposed && failure.isMainFrame && failure.errorCode !== -3) onError(new Error(ct('client.pageLoadFailed')));
    });
    element.addEventListener('render-process-gone', () => {
      generation += 1;
      if (!disposed) onError(new Error(ct('client.pageExited')));
    });
    unsubscribe = bridge.onOpenRequested?.(lease, (url: string) => {
      // The shell validates these user-clicked HTTP(S) links before publishing them.
      if (!disposed && /^https?:/.test(url)) window.open(url, '_blank', 'noopener');
    });
    host.append(element);
  })().catch((error: Error) => {
    if (!disposed) onError(error);
  });

  return adapter;
}
