import { appOrigin, readHandoff } from './handoff.js';
import { openWorkspace } from './workspace-session.js';
import { readEmbed } from './conversation-protocol.js';
import { startConversationGuest } from './conversation-guest.js';
import { ct } from './i18n/client.js';
import type {
  ClientContext,
  ClientModel,
  HandoffRecord,
  PanelApi,
  PanelStatus,
  PendingHandoff,
  Store,
} from './client-types.js';

const PREFIX = 'dsh-wsl-native:';

/** Recorded workspace choice per project directory. */
type Selection = Record<string, string>;

/**
 * Read or write one small value in session or local storage.
 *
 * Storage is best-effort: private browsing and quota limits must not break the
 * panel, so a failing read or write simply behaves like an empty value.
 */
export function stored<T>(
  key: string,
  value?: T | null,
  storage: Storage = sessionStorage,
): T | null {
  try {
    if (value === undefined) return JSON.parse(storage.getItem(PREFIX + key) || 'null') as T | null;
    if (value === null) storage.removeItem(PREFIX + key);
    else storage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* Private browsing and storage limits do not prevent working. */
  }
  return null;
}

/** Wait until a controller store is ready, or fail on abort/timeout. */
function ready(source: Store<{ phase: string }>, signal?: AbortSignal): Promise<void> {
  if (source.getSnapshot().phase === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let dispose = (): void => {};
    const timer = setTimeout(() => finish(new Error(ct('client.workspaceLoading'))), 30000);
    const finish = (error?: Error): void => {
      dispose();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => finish(new Error(ct('client.workspaceCanceled')));
    dispose = source.subscribe(() => {
      if (source.getSnapshot().phase === 'ready') finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else if (source.getSnapshot().phase === 'ready') finish();
  });
}

/** Open (or reuse) the workspace for a directory and show its most recent session. */
export async function openProject(
  ctx: ClientContext,
  directory: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await Promise.all([ready(ctx.workspaces.list, signal), ready(ctx.sessions.list, signal)]);
  if (signal?.aborted) return false;
  const navigation = ctx.layout.beginNavigation();
  const workspace = await ctx.workspaces.create({ path: directory });
  await ctx.sessions.refresh();
  if (signal?.aborted || navigation.aborted) return false;
  const { byId } = ctx.sessions.list.getSnapshot();
  const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds;
  const choices = workspace.sessionIds
    .map((id) => byId[id])
    .filter(
      (item): item is NonNullable<typeof item> =>
        item !== undefined &&
        !item.parentId &&
        !archived.includes(item.id) &&
        item.cwd === workspace.path,
    );
  const saved = stored<Selection>('selection', undefined, localStorage)?.[workspace.path];
  const selected =
    choices.find((item) => item.id === saved) ??
    choices.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (selected) ctx.uiWorkspace.openSession(selected.id);
  else await openWorkspace(ctx, workspace.workspaceId, signal);
  return true;
}

/** Build the panel model: status, persisted choices and handoff adoption. */
export function createClientModel(ctx: ClientContext, api: PanelApi): ClientModel {
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let refreshPromise: Promise<PanelStatus> | undefined;
  let disposed = false;
  let booting = false;
  let lastSelection: string | undefined;

  const model: ClientModel = {
    state: null,
    error: null,
    draft: null,
    pending: stored<PendingHandoff>('pending'),
    popup: null,
    parentOrigin: appOrigin(stored<string>('parentOrigin')),
    readyLink: null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      if (disposed) return;
      for (const listener of listeners) listener();
    },
    async refresh(): Promise<PanelStatus> {
      if (refreshPromise) return refreshPromise;
      refreshPromise = api('status')
        .then((state) => {
          if (!disposed) {
            model.state = state as PanelStatus;
            model.error = null;
            model.parentOrigin ||= model.state.parentOrigin;
            model.emit();
          }
          return model.state as PanelStatus;
        })
        .catch((error: Error) => {
          model.error = error.message;
          model.emit();
          throw error;
        })
        .finally(() => {
          refreshPromise = undefined;
        });
      return refreshPromise;
    },
    setPending(pending: PendingHandoff | null) {
      model.pending = pending;
      stored('pending', pending);
      model.emit();
    },
    remember() {
      const catalog = ctx.sessions.list.getSnapshot();
      const current = catalog.ids
        .map((id) => catalog.byId[id])
        .find((row) => row !== undefined && (row.retainedBy?.mainView ?? 0) > 0 && row.cwd && !row.parentId);
      if (!current || lastSelection === current.id || !current.cwd) return;
      lastSelection = current.id;
      const selections = stored<Selection>('selection', undefined, localStorage) ?? {};
      const next = Object.fromEntries(
        [
          [current.cwd, current.id],
          ...Object.entries(selections).filter(([key]) => key !== current.cwd),
        ].slice(0, 64),
      );
      stored('selection', next, localStorage);
    },
    async adopt(): Promise<void> {
      const handoff = readHandoff(window.location.hash);
      const embed = readEmbed(window.location.hash);
      if (!handoff || booting || (stored<string>('arrived') === handoff.id && !embed)) return;
      booting = true;
      try {
        const state = model.state ?? (await model.refresh());
        if (state.mode !== 'wsl-host' || !state.distros.some((distro) => distro.name === handoff.distro)) {
          throw new Error(ct('client.targetMismatch'));
        }
        const result = (await api('environment/adopt', handoff as unknown as Record<string, unknown>)) as {
          settings: { directory: string };
        };
        if (disposed) return;
        if (handoff.parentOrigin) {
          model.parentOrigin = handoff.parentOrigin;
          stored('parentOrigin', handoff.parentOrigin);
        }
        // The parent owns embedded navigation. Establish the verified channel even
        // when native startup changes selection; warming a page must not create a session.
        if (embed) startConversationGuest(ctx, model, api, embed);
        if (embed || (await openProject(ctx, result.settings.directory, lifetime.signal))) {
          stored('arrived', handoff.id);
          history.replaceState(history.state, '', window.location.pathname + window.location.search);
          await model.refresh();
        }
      } catch (error) {
        model.error = (error as Error).message;
        model.emit();
        if (!disposed) ctx.layout.selectPanel('dsh-wsl-native');
      } finally {
        booting = false;
      }
    },
  };

  const reset = (): void => {
    void model
      .refresh()
      .then(() => model.adopt())
      .catch(() => {});
  };
  const stopReset = ctx.on('connection/reset', reset);
  const stopSessions = ctx.sessions.list.subscribe(() => model.remember());
  window.addEventListener('hashchange', model.adopt);
  window.addEventListener('focus', reset);
  reset();
  model.dispose = () => {
    disposed = true;
    model.guest?.dispose?.();
    model.conversations?.dispose?.();
    lifetime.abort();
    stopReset();
    stopSessions();
    window.removeEventListener('hashchange', model.adopt);
    window.removeEventListener('focus', reset);
    listeners.clear();
  };
  return model;
}

/** Re-exported for callers that only need the handoff record shape. */
export type { HandoffRecord };
