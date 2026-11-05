import { stored } from './client-session.js';
import { startSession } from './workspace-session.js';
import { createConnectionRecovery, type RecoveryState } from './connection-recovery.js';
import { createWorkHandoff } from './work-handoff.js';
import { readHandoff, appOrigin, DESKTOP_ORIGIN, type Handoff } from './handoff.js';
import {
  acceptsMessage,
  catalogOf,
  cleanCatalog,
  conversationKey,
  embeddedUrl,
  CONVERSATION_PANEL,
  CONVERSATION_PROTOCOL,
  type ConversationRow,
} from './conversation-protocol.js';
import { ct } from './i18n/client.js';
import type {
  Catalog,
  ClientContext,
  ClientModel,
  EnvironmentSettings,
  PanelApi,
  PanelStatus,
} from './client-types.js';

/** Navigation intent forwarded to a guest once it is ready. */
export interface ConversationIntent {
  sessionId?: string;
  create?: boolean;
  connectOnly?: boolean;
  handoff?: Handoff | null;
}

/** One open Linux environment inside the Windows panel. */
export interface ConversationEntry {
  key: string;
  settings: EnvironmentSettings;
  origin?: string | null;
  channel?: string;
  catalog?: Catalog | null;
  recovery?: RecoveryState | null;
  url?: string;
  openUrl?: string;
  transport?: 'desktop' | 'iframe';
  ready?: boolean;
  compact?: boolean;
  window?: Window | null;
  desktop?: { request(action: string, payload: Record<string, unknown>): Promise<unknown> };
  waiting?: ConversationIntent | null;
  startedAt?: number;
  handoff?: Handoff | null;
  configOpen?: boolean;
  navigating?: string | null;
  lastSeen?: number;
}

/** Message received from a guest page or the Desktop bridge. */
interface GuestMessageLike {
  type?: string;
  id?: string;
  ok?: boolean;
  value?: unknown;
  error?: unknown;
  catalog?: unknown;
}

/** Dialog the panel is currently showing. */
export type ConversationDialog =
  | { type: 'workspace' }
  | { type: 'rename'; target: ConversationRow }
  | { type: 'handoff'; source: { id: string; row: ConversationRow; entry?: ConversationEntry } }
  | null;

/** Pending request forwarded to a guest. */
interface PendingRequest {
  entry: ConversationEntry;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The conversations model the panel renders and calls. */
export interface ConversationModel {
  entries: Map<string, ConversationEntry>;
  activeKey: string | null;
  error: string | null;
  busy: boolean;
  anchor: HTMLElement | null;
  dialog: ConversationDialog;
  catalogRevision: number;
  workspaceOrder: string[];
  unified: boolean;
  requestWorkspace(): void;
  requestRename(target: ConversationRow): void;
  requestHandoff(source: { id: string; row: ConversationRow; entry?: ConversationEntry }): void;
  handoff(
    entry: ConversationEntry | null | undefined,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { sessionId?: string }>;
  setWorkspaceOrder(order: string[]): void;
  remote(entry: ConversationEntry, action: string, payload?: Record<string, unknown>): Promise<unknown>;
  nativeCatalog(): Catalog;
  visible(): boolean;
  changed(): void;
  setUnified(value: boolean): void;
  setAnchor(element: HTMLElement | null): void;
  showWindows(sessionId?: string): void;
  openRow(row: ConversationRow): Promise<void>;
  enter(settings: EnvironmentSettings, intent?: ConversationIntent, select?: boolean, automatic?: boolean): Promise<void>;
  adopt(handoff: Handoff & { url: string; settings: EnvironmentSettings }, intent?: ConversationIntent, select?: boolean): Promise<void>;
  bind(entry: ConversationEntry, iframe: HTMLIFrameElement | null): void;
  desktopMessage(entry: ConversationEntry, message: unknown): void;
  desktopError(entry: ConversationEntry, error: Error): void;
  newWindows(workspaceId?: string): Promise<void>;
  newLinux(entry?: ConversationEntry): Promise<void>;
  action(row: ConversationRow, action: string): Promise<void>;
  toggleChrome(entry: ConversationEntry): void;
  closeView(entry: ConversationEntry): void;
  stopRecovery(settings?: EnvironmentSettings): void;
  reconnect(entry: ConversationEntry, automatic?: boolean): Promise<void>;
  dispose(): void;
}

/** Build the conversation model: environments, guests, navigation and drafts. */
export function createConversations(
  ctx: ClientContext,
  api: PanelApi,
  model: ClientModel,
): ConversationModel {
  const entries = new Map<string, ConversationEntry>();
  const requests = new Map<string, PendingRequest>();
  const lifetime = new AbortController();
  const closedViews = new Set<string>();
  const requestedEnvironments = new Set<string>();
  const starting = new Map<string, Promise<Handoff & { url: string; settings: EnvironmentSettings }>>();
  let revision = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLocal: string | undefined;
  let startupChecked = false;

  const recovery = createConnectionRecovery<ConversationEntry>({
    retry: (entry) => chat.reconnect(entry, true),
    current: (key) =>
      !lifetime.signal.aborted && !closedViews.has(key) && requestedEnvironments.has(key)
        ? (entries.get(key) ?? null)
        : null,
    changed: () => model.emit(),
  });
  const localHandoff = createWorkHandoff(ctx);
  const savedOrder = stored<unknown>('workspace-order', undefined, localStorage);

  const chat: ConversationModel = {
    entries,
    activeKey: null,
    error: null,
    busy: false,
    anchor: null,
    dialog: null,
    catalogRevision: 0,
    workspaceOrder: Array.isArray(savedOrder)
      ? savedOrder.filter((id): id is string => typeof id === 'string').slice(0, 16000)
      : [],
    unified: stored<string>('sidebar-view-v050', undefined, localStorage) === 'conversations',
    requestWorkspace() {
      chat.dialog = { type: 'workspace' };
      model.emit();
    },
    requestRename(target) {
      chat.dialog = { type: 'rename', target };
      model.emit();
    },
    requestHandoff(source) {
      chat.dialog = { type: 'handoff', source };
      model.emit();
    },
    async handoff(entry, action, payload) {
      const result = (entry
        ? await chat.remote(entry, action, payload)
        : await localHandoff(action, payload)) as Record<string, unknown> & { sessionId?: string };
      if (action === 'handoff.deliver') {
        if (entry) {
          chat.activeKey = entry.key;
          ctx.layout.selectPanel(CONVERSATION_PANEL);
        } else {
          chat.showWindows(result.sessionId);
        }
        model.emit();
      }
      return result;
    },
    setWorkspaceOrder(order) {
      chat.workspaceOrder = order;
      stored('workspace-order', order, localStorage);
      model.emit();
    },
    async remote(entry, action, payload = {}) {
      if (!entry.ready) {
        await chat.enter(entry.settings, { connectOnly: true }, false);
        await new Promise<void>((resolve, reject) => {
          let unsubscribe = (): void => {};
          const timer = setTimeout(
            () => finish(new Error(chat.error ?? ct('client.guestTimeout'))),
            180000,
          );
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            unsubscribe();
            lifetime.signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          };
          const abort = (): void => finish(new Error(ct('client.windowClosed')));
          const check = (): void => {
            const current = entries.get(entry.key);
            if (current?.ready) {
              entry = current;
              finish();
            } else if (closedViews.has(entry.key)) {
              finish(new Error(ct('client.environmentClosed')));
            } else if (current?.recovery?.phase === 'failed' || chat.error) {
              finish(new Error(current?.recovery?.message ?? chat.error ?? ''));
            }
          };
          unsubscribe = model.subscribe(check);
          lifetime.signal.addEventListener('abort', abort, { once: true });
          check();
        });
      }
      const value = await request(entry, action, payload);
      // Refresh after mutations so subsequent actions use authoritative membership.
      if (action !== 'search') await request(entry, 'refresh', {});
      return value;
    },
    nativeCatalog: () => catalogOf(ctx),
    visible: () => ctx.layout.panelInfo.getSnapshot().activePanelId === CONVERSATION_PANEL,
    changed() {
      model.emit();
    },
    setUnified(value) {
      chat.unified = value;
      stored('sidebar-view-v050', value ? 'conversations' : 'workspaces', localStorage);
      model.emit();
    },
    setAnchor(element) {
      chat.anchor = element;
      model.emit();
    },
    showWindows(sessionId) {
      revision++;
      chat.error = null;
      if (sessionId) ctx.uiWorkspace.openSession(sessionId);
      else ctx.layout.selectPanel(null);
      model.emit();
    },
    async openRow(row) {
      if (!row.environment) {
        chat.showWindows(row.id);
        return;
      }
      const entry = entries.get(row.environment.key);
      if (!entry?.ready) {
        if (entry) await chat.enter(entry.settings, { sessionId: row.id });
        return;
      }
      revision++;
      chat.activeKey = entry.key;
      chat.error = null;
      ctx.layout.selectPanel(CONVERSATION_PANEL);
      model.emit();
      try {
        await navigate(entry, { sessionId: row.id });
      } catch (error) {
        chat.error = (error as Error).message;
        model.emit();
      }
    },
    async enter(settings, intent = {}, select = true, automatic = false) {
      const key = conversationKey(settings);
      if (lifetime.signal.aborted || (automatic && closedViews.has(key))) return;
      if (!automatic) {
        recovery.cancel(key);
        const existing = entries.get(key);
        if (existing?.recovery) {
          existing.recovery = null;
          existing.origin = null;
        }
      }
      closedViews.delete(key);
      requestedEnvironments.add(key);
      const current = select ? ++revision : revision;
      chat.error = null;
      model.emit();
      try {
        const handoff = await ensureHost(settings);
        if (lifetime.signal.aborted || closedViews.has(key)) return;
        await chat.adopt(
          handoff,
          current !== revision ? { connectOnly: true } : intent,
          select && current === revision,
        );
      } catch (error) {
        if (automatic) throw error;
        chat.error = (error as Error).message;
        model.emit();
      }
    },
    async adopt(handoff, intent = {}, select = true) {
      const key = conversationKey(handoff.settings);
      closedViews.delete(key);
      requestedEnvironments.add(key);
      const origin = new URL(handoff.url).origin;
      let entry = entries.get(key);
      if (!entry || entry.origin !== origin) {
        if ([...entries.values()].filter((item) => item.url && item.key !== key).length >= 8) {
          throw new Error(ct('client.tooManyEnvironments'));
        }
        if (entry) rejectRequests(entry, ct('client.environmentRestarted'));
        const channel = crypto.randomUUID();
        entry = {
          key,
          settings: handoff.settings,
          origin,
          channel,
          catalog: entry?.catalog ?? null,
          recovery: entry?.recovery ?? null,
          url: embeddedUrl(handoff.url, channel, location.origin),
          openUrl: handoff.url,
          transport: appOrigin(location.origin) === DESKTOP_ORIGIN ? 'desktop' : 'iframe',
          ready: false,
          compact: true,
          window: null,
          waiting: null,
          startedAt: Date.now(),
        };
        entries.set(key, entry);
      } else {
        entry.settings = handoff.settings;
        entry.openUrl = handoff.url;
      }
      entry.handoff = readHandoff(new URL(handoff.url).hash);
      if (select) {
        chat.activeKey = key;
        ctx.layout.selectPanel(CONVERSATION_PANEL);
      }
      const payload: ConversationIntent = { handoff: entry.handoff, ...intent };
      if (!intent.connectOnly) {
        if (entry.ready) await navigate(entry, payload);
        else entry.waiting = payload;
      }
      save();
      model.emit();
    },
    bind(entry, iframe) {
      entry.window = iframe?.contentWindow ?? null;
    },
    desktopMessage(entry, message) {
      if (entries.get(entry.key) === entry) accept(entry, message as GuestMessageLike);
    },
    desktopError(entry, error) {
      if (entries.get(entry.key) !== entry) return;
      entry.ready = false;
      rejectRequests(entry, error.message);
      recovery.failed(entry, error);
      model.emit();
    },
    async newWindows(workspaceId) {
      revision++;
      chat.error = null;
      try {
        await startSession(ctx, workspaceId);
      } catch (error) {
        chat.error = (error as Error).message;
      }
      model.emit();
    },
    async newLinux(entry) {
      const settings = entry?.settings ?? model.state?.settings;
      if (!settings?.distro) {
        ctx.layout.selectPanel('dsh-wsl-native');
        return;
      }
      const selected = entry?.catalog?.rows.find((row) => row.id === entry.catalog?.selectedId);
      await chat.enter(
        { ...settings, directory: selected?.cwd ?? settings.directory },
        { create: true },
      );
    },
    async action(row, action) {
      chat.error = null;
      try {
        if (row.environment) {
          const entry = entries.get(row.environment.key);
          if (entry) await chat.remote(entry, action, { sessionId: row.id });
        } else {
          const names: Record<string, keyof ClientContext['uiWorkspace']> = {
            pin: 'pinSession',
            unpin: 'unpinSession',
            archive: 'archiveSession',
            unarchive: 'unarchiveSession',
          };
          const name = names[action];
          if (!name) throw new Error(ct('client.invalidConversationAction'));
          const operation = ctx.uiWorkspace[name];
          if (typeof operation !== 'function') throw new Error(ct('client.invalidConversationAction'));
          await (operation as (id: string) => Promise<unknown>).call(ctx.uiWorkspace, row.id);
        }
      } catch (error) {
        chat.error = (error as Error).message;
      }
      model.emit();
    },
    toggleChrome(entry) {
      const panel = entry.configOpen ? null : 'plugins';
      void request(entry, 'chrome', { compact: true, panel })
        .then(() => {
          entry.configOpen = panel !== null;
          entry.compact = true;
          model.emit();
        })
        .catch((error: Error) => {
          chat.error = error.message;
          model.emit();
        });
    },
    closeView(entry) {
      closedViews.add(entry.key);
      recovery.cancel(entry.key);
      rejectRequests(entry, ct('client.environmentPageClosed'));
      if (chat.activeKey === entry.key) chat.showWindows();
      delete entry.url;
      entry.window = null;
      entry.ready = false;
      entry.origin = null;
      entry.waiting = null;
      save();
      model.emit();
    },
    stopRecovery(settings) {
      for (const key of requestedEnvironments) {
        if (!settings || key === conversationKey(settings)) {
          closedViews.add(key);
          recovery.cancel(key);
        }
      }
      for (const entry of entries.values()) {
        if (!settings || entry.key === conversationKey(settings)) chat.closeView(entry);
      }
    },
    reconnect(entry, automatic = false) {
      if (entries.get(entry.key) !== entry || closedViews.has(entry.key)) return Promise.resolve();
      if (!automatic) {
        recovery.cancel(entry.key);
        entry.recovery = null;
      }
      // Only an intent never dispatched to the guest may survive reconnect.
      const intent: ConversationIntent =
        entry.waiting ?? (entry.catalog?.selectedId ? { sessionId: entry.catalog.selectedId } : { connectOnly: true });
      rejectRequests(entry, ct('client.reconnecting'));
      entry.origin = null;
      return chat.enter(
        entry.settings,
        intent,
        !automatic && chat.visible() && chat.activeKey === entry.key,
        automatic,
      );
    },
    dispose() {
      lifetime.abort();
      recovery.dispose();
      observer.disconnect();
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      window.removeEventListener('message', receive);
      for (const dispose of disposers) dispose();
      for (const entry of entries.values()) rejectRequests(entry, ct('client.windowClosed'));
    },
  };

  async function ensureHost(
    settings: EnvironmentSettings,
  ): Promise<Handoff & { url: string; settings: EnvironmentSettings }> {
    const key = JSON.stringify([conversationKey(settings), settings.directory]);
    const pending = starting.get(key);
    if (pending) return pending;
    const operation = Promise.resolve()
      .then(async () => {
        const result = (await api('native/enter', {
          ...settings,
          parentOrigin: appOrigin(location.origin),
        })) as { id: string };
        const until = Date.now() + 10 * 60 * 1000;
        while (!lifetime.signal.aborted && Date.now() < until) {
          const state: PanelStatus = await model.refresh();
          const handoff = state.handoffs.find((item) => item.id === result.id);
          if (handoff?.state === 'failed') throw new Error(handoff.error ?? ct('client.launchFailed'));
          if (handoff?.state === 'ready') return handoff as unknown as Handoff & { url: string; settings: EnvironmentSettings };
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        throw new Error(ct('client.launchIncomplete'));
      })
      .finally(() => {
        starting.delete(key);
        chat.busy = starting.size > 0;
        model.emit();
      });
    starting.set(key, operation);
    chat.busy = true;
    model.emit();
    return operation;
  }

  function save(): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () =>
        stored(
          'conversation-catalogs',
          [...entries.values()].map((entry) => ({
            key: entry.key,
            settings: entry.settings,
            catalog: entry.catalog,
          })),
          localStorage,
        ),
      200,
    );
  }

  const cached =
    stored<unknown>('conversation-catalogs', undefined, localStorage) ??
    stored<unknown>('conversation-catalogs');
  for (const saved of (Array.isArray(cached) ? cached : []).slice(0, 8) as {
    settings?: EnvironmentSettings;
    catalog?: unknown;
  }[]) {
    if (!saved?.settings?.distro || !saved?.settings?.directory || !cleanCatalog(saved.catalog)) continue;
    const key = conversationKey(saved.settings);
    const catalog = cleanCatalog(saved.catalog);
    if (!catalog) continue;
    entries.set(key, { key, settings: saved.settings, catalog, ready: false, compact: true });
  }

  function request(
    entry: ConversationEntry,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if ((!entry.window && !entry.desktop) || !entry.ready) {
      return Promise.reject(new Error(ct('client.guestNotConnected')));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(ct('client.guestNoResponse')));
      }, 30000);
      requests.set(id, { entry, resolve, reject, timer });
      if (entry.desktop) {
        void entry.desktop.request(action, payload).then(
          (value) => accept(entry, { type: 'result', id, ok: true, value }),
          (error: Error) => accept(entry, { type: 'result', id, ok: false, error: error.message }),
        );
      } else {
        entry.window?.postMessage(
          { protocol: CONVERSATION_PROTOCOL, channel: entry.channel, type: 'request', id, action, payload },
          entry.origin ?? '',
        );
      }
    });
  }

  async function navigate(entry: ConversationEntry, payload: ConversationIntent): Promise<void> {
    const id = crypto.randomUUID();
    entry.navigating = id;
    model.emit();
    try {
      await request(entry, 'navigate', payload as Record<string, unknown>);
      entry.configOpen = false;
    } finally {
      if (entry.navigating === id) entry.navigating = null;
      model.emit();
    }
  }

  function rejectRequests(entry: ConversationEntry, reason: string): void {
    for (const [id, pending] of requests) {
      if (pending.entry !== entry) continue;
      clearTimeout(pending.timer);
      requests.delete(id);
      pending.reject(new Error(reason));
    }
  }

  function theme(entry: ConversationEntry): void {
    const style = document.body.style;
    const tokens = [...style]
      .filter((name) => /^--(?:ds|dsw|dsh)-/.test(name))
      .map((name) => [name, style.getPropertyValue(name)]);
    void request(entry, 'theme', {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      tokens,
    }).catch(() => {});
  }

  const receive = (event: MessageEvent): void => {
    for (const entry of entries.values()) {
      const target = {
        origin: entry.origin ?? '',
        source: entry.window ?? null,
        channel: entry.channel ?? '',
      };
      if (acceptsMessage(event, target)) {
        accept(entry, event.data as GuestMessageLike);
        return;
      }
    }
  };

  function accept(entry: ConversationEntry, message: GuestMessageLike): void {
    if (message.type === 'catalog') {
      const catalog = cleanCatalog(message.catalog);
      if (!catalog) return;
      const first = !entry.ready;
      entry.ready = catalog.phase === 'ready' && catalog.connected;
      entry.catalog = catalog;
      entry.lastSeen = Date.now();
      chat.catalogRevision++;
      if (catalog.connected && entry.ready) recovery.connected(entry);
      else if (!catalog.connected) recovery.failed(entry, new Error(ct('client.connectionLost')), 15000);
      if (first && entry.ready) theme(entry);
      if (entry.waiting && entry.ready && catalog.connected) {
        const payload = entry.waiting;
        entry.waiting = null;
        void navigate(entry, payload).catch((error: Error) => {
          chat.error = error.message;
          model.emit();
        });
      }
      save();
      model.emit();
      return;
    }
    if (message.type === 'result') {
      const pending = typeof message.id === 'string' ? requests.get(message.id) : undefined;
      if (!pending || pending.entry !== entry || typeof message.id !== 'string') return;
      clearTimeout(pending.timer);
      requests.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(String(message.error ?? ct('client.operationFailed')).slice(0, 1000)));
      return;
    }
    if (message.type === 'return') chat.showWindows();
    else if (message.type === 'sidebar') ctx.layout.toggleSidebar();
  }

  window.addEventListener('message', receive);
  const observer = new MutationObserver(() => {
    for (const entry of entries.values()) if (entry.ready) theme(entry);
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] });

  const notifyLocal = (): void => {
    const next = JSON.stringify(catalogOf(ctx));
    if (next !== lastLocal) {
      lastLocal = next;
      model.emit();
    }
  };
  const restoreRunning = (): void => {
    const state = model.state;
    if (state?.mode !== 'windows-host') return;
    if (!startupChecked) {
      startupChecked = true;
      if (state.preferences.autoStartWsl === true) {
        const settings = state.settings;
        const distro =
          settings.distro ||
          state.distros.find((item) => item.isDefault)?.name ||
          state.distros[0]?.name;
        if (distro) {
          void chat.enter({ ...settings, distro }, { connectOnly: true }, false).catch(() => {});
        }
      }
    }
  };
  const disposers = [
    ctx.sessions.list.subscribe(notifyLocal),
    ctx.workspaces.list.subscribe(notifyLocal),
    ctx.layout.panelInfo.subscribe(() => {
      model.emit();
    }),
    model.subscribe(restoreRunning),
  ];
  restoreRunning();
  return chat;
}
