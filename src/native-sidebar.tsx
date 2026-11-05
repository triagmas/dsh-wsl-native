import { useMemo } from 'react';
import {
  MenuItemButton,
  IconPinOutlineRegular,
  IconArchiveOutlineRegular,
  IconEditOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { useModel } from './page.js';
import { projectWorkspaces, reorderWorkspace, remoteId } from './workspace-projection.js';
import { CONVERSATION_PANEL } from './conversation-protocol.js';
import { ct } from './i18n/client.js';
import type {
  ClientContext,
  ClientModel,
  SearchHit,
  SessionList,
  SlotDefinition,
  SlotEntry,
  WorkspaceList,
} from './client-types.js';
import type { Projection, ProjectedStatus, RemoteTarget } from './workspace-projection.js';
import type { ConversationRow } from './conversation-protocol.js';
import type { PanelModel } from './panel-types.js';

/** A React-like selector hook over an immutable snapshot. */
export type SelectorHook<T> = <R>(selector: (state: T) => R) => R;

/** Search result list shape used by the sidebar search box. */
interface SearchResults {
  items: SearchHit[];
  hasMore: boolean;
}

/** Panel info snapshot the sidebar exposes. */
interface SidebarPanelInfo {
  activePanelId: string | null;
  [key: string]: unknown;
}

/** Props the mirrored Harness sidebar entry receives from DSH. */
export interface NativeSidebarProps {
  useSessions: SelectorHook<SessionList>;
  useWorkspaces: SelectorHook<WorkspaceList>;
  useSessionStatus: SelectorHook<Map<string, ProjectedStatus>>;
  usePanelInfo: SelectorHook<SidebarPanelInfo>;
  startSession(id: string): void;
  open(id: string): void;
  requestSessionRename(id: string, title: string): void;
  renameWorkspace(id: string, title: string): void;
  deleteWorkspace(id: string): void;
  insertWorkspaceBefore(id: string, before: string): Promise<void>;
  unarchiveSession(id: string): Promise<void>;
  searchSessions(query: string, signal?: AbortSignal): Promise<SearchResults>;
  searchResultLimit: number;
  renderSlot(name: string, owner: { sessionId: string; [key: string]: unknown }, options: MenuOptions): React.ReactNode;
}

/** Options forwarded into a mirrored menu slot. */
interface MenuOptions {
  hookContext?: unknown[];
}

/** Nested mirror bookkeeping. */
interface Mirror {
  declarations: Record<string, SlotDefinition>;
  start(): () => void;
}

/**
 * Mirror child slots under an owned namespace.
 *
 * The original registrations and their authorization stay intact; nothing here
 * patches a private renderer or an entry owned by the Harness.
 */
function mirrorChildren(
  ctx: ClientContext,
  children: Record<string, SlotEntry> | undefined,
  prefix: string,
): Mirror {
  const declarations: Record<string, SlotDefinition> = Object.fromEntries(
    Object.entries(children ?? {}).map(([key, spec]) => [
      prefix + key,
      {
        name: prefix + key,
        ...(spec.locale === undefined ? {} : { locale: spec.locale }),
        ...(spec.inject === undefined ? {} : { inject: spec.inject }),
        ...(spec.store === undefined || spec.store === null ? {} : { store: spec.store }),
      },
    ]),
  );
  const releases: (() => void)[] = [];
  const start = (): (() => void) => {
    for (const key of Object.keys(children ?? {})) {
      const copies: (() => void)[] = [];
      const sync = (): void => {
        copies
          .splice(0)
          .reverse()
          .forEach((dispose) => dispose());
        for (const entry of ctx.slots.entries(key)) {
          const nested = mirrorChildren(ctx, entry.children, prefix);
          const Component = entry.component as React.ComponentType<Record<string, unknown>>;
          copies.push(
            ctx.slots.register(
              {
                name: prefix + key,
                ...(entry.options ?? {}),
                ...(entry.inject === undefined ? {} : { inject: entry.inject }),
                ...(entry.store === undefined || entry.store === null ? {} : { store: entry.store }),
                ...(entry.locale === undefined ? {} : { locale: entry.locale }),
                ...(entry.children === undefined ? {} : { children: nested.declarations }),
              },
              entry.children
                ? (props: Record<string, unknown>) => (
                    <Component
                      {...props}
                      renderSlot={(name: string, owner: unknown, options: MenuOptions) =>
                        (props.renderSlot as (n: string, o: unknown, op: MenuOptions) => React.ReactNode)(
                          prefix + name,
                          owner,
                          options,
                        )
                      }
                    />
                  )
                : Component,
            ),
          );
          if (entry.children) copies.push(nested.start());
        }
      };
      sync();
      releases.push(ctx.slots.subscribe(key, sync), () => {
        copies
          .splice(0)
          .reverse()
          .forEach((dispose) => dispose());
      });
    }
    return () => {
      releases
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
    };
  };
  return { declarations, start };
}

/** Adapter that projects Linux catalogs into the native sidebar component. */
function NativeWorkspaceAdapter({
  Native,
  ctx,
  model,
  prefix,
  ...props
}: NativeSidebarProps & {
  Native: React.ComponentType<Record<string, unknown>>;
  ctx: ClientContext;
  model: PanelModel;
  prefix: string;
}) {
  useModel(model);
  const chat = model.conversations;
  const localSessions = props.useSessions((state) => state);
  const localWorkspaces = props.useWorkspaces((state) => state);
  const localStatus = props.useSessionStatus((state) => state);
  const panelInfo = props.usePanelInfo((info) => info);
  const entries = [...chat.entries.values()];
  const activeKey = chat.visible() ? chat.activeKey : null;
  // Catalogs keep their reference until the guest publishes a change.
  const projection: Projection = useMemo(
    () =>
      projectWorkspaces(
        localSessions,
        localWorkspaces,
        localStatus,
        entries,
        activeKey,
        chat.workspaceOrder,
      ),
    [localSessions, localWorkspaces, localStatus, activeKey, chat.workspaceOrder, chat.catalogRevision],
  );
  const target = (id: string): RemoteTarget | undefined => projection.targets.get(id);
  const attempt = (action: () => unknown): void => {
    void Promise.resolve()
      .then(action)
      .catch((error: Error) => {
        chat.error = error.message;
        model.emit();
      });
  };
  const selectLinux = (entry: { key: string }): void => {
    chat.activeKey = entry.key;
    ctx.layout.selectPanel(CONVERSATION_PANEL);
    model.emit();
  };
  const run = async (id: string, action: string, payload: Record<string, unknown> = {}): Promise<void> => {
    const item = target(id);
    if (!item) throw new Error(ct('ui.sidebar.changed'));
    await chat.remote(item.entry, action, {
      [item.kind === 'workspace' ? 'workspaceId' : 'sessionId']: item.id,
      ...payload,
    });
    if (action === 'workspace.start' || action === 'session.fork') selectLinux(item.entry);
  };
  const rowOf = (item: RemoteTarget): ConversationRow | null =>
    item.row
      ? {
          ...item.row,
          key: item.entry.key,
          environment: {
            key: item.entry.key,
            settings: item.entry.settings,
            catalog: item.entry.catalog ?? null,
          },
        }
      : null;
  const rename = (id: string, title: string): void => {
    const row = target(id);
    const conversation = row ? rowOf(row) : null;
    if (conversation) chat.requestRename({ ...conversation, title });
    else props.requestSessionRename(id, title);
  };
  const archive = (item: RemoteTarget): void => {
    const row = rowOf(item);
    if (row?.running) {
      chat.dialog = { type: 'archive', target: row };
      model.emit();
    } else attempt(() => chat.remote(item.entry, 'archive', { sessionId: item.id }));
  };
  const renderSlot = (name: string, owner: { sessionId: string; [key: string]: unknown }, options: MenuOptions): React.ReactNode => {
    const item = target(owner.sessionId);
    if (!item) return props.renderSlot(prefix + name, owner, options);
    const displayTitle = typeof owner.displayTitle === 'string' ? owner.displayTitle : '';
    if (name === 'sidebar.workspaces.session.menu.item') {
      const choose = (action: () => void) => () => {
        const close = options?.hookContext?.[1];
        if (typeof close === 'function') (close as (value: boolean) => void)(false);
        action();
      };
      return (
        <>
          {!item.row?.archived ? (
            <MenuItemButton
              icon={<IconPinOutlineRegular />}
              onSelect={choose(() => attempt(() => run(owner.sessionId, item.row?.pinned ? 'unpin' : 'pin')))}
            >
              {item.row?.pinned ? ct('ui.sidebar.unpin') : ct('ui.sidebar.pin')}
            </MenuItemButton>
          ) : null}
          <MenuItemButton icon={<IconEditOutlineRegular />} onSelect={choose(() => rename(owner.sessionId, displayTitle))}>
            {ct('ui.sidebar.rename')}
          </MenuItemButton>
          <MenuItemButton onSelect={choose(() => attempt(() => run(owner.sessionId, 'session.fork')))}>
            {ct('ui.sidebar.fork')}
          </MenuItemButton>
          <MenuItemButton
            onSelect={choose(() => {
              const row = rowOf(item);
              if (row) chat.requestHandoff({ id: item.id, row, entry: item.entry });
            })}
          >
            {ct('ui.handoff.menu')}
          </MenuItemButton>
          <MenuItemButton
            icon={<IconArchiveOutlineRegular />}
            onSelect={choose(() =>
              item.row?.archived ? attempt(() => run(owner.sessionId, 'unarchive')) : archive(item),
            )}
          >
            {item.row?.archived ? ct('ui.sidebar.unarchive') : ct('ui.sidebar.archive')}
          </MenuItemButton>
        </>
      );
    }
    if (name === 'sidebar.workspaces.session.row.action' && !item.row?.archived) {
      return (
        <>
          <button
            className="dsh-wsl-row-action"
            title={ct('ui.sidebar.archive')}
            aria-label={ct('ui.sidebar.archiveWsl')}
            onClick={() => archive(item)}
          >
            <IconArchiveOutlineRegular size={14} />
          </button>
          <button
            className="dsh-wsl-row-action"
            title={item.row?.pinned ? ct('ui.sidebar.unpin') : ct('ui.sidebar.pin')}
            aria-label={item.row?.pinned ? ct('ui.sidebar.unpinWsl') : ct('ui.sidebar.pinWsl')}
            onClick={() => attempt(() => run(owner.sessionId, item.row?.pinned ? 'unpin' : 'pin'))}
          >
            <IconPinOutlineRegular size={14} />
          </button>
        </>
      );
    }
    if (name === 'sidebar.session.row.hover') {
      return (
        <div className="dsh-wsl-caption">
          WSL · {item.entry.settings.distro} · {item.entry.settings.user || ct('ui.workspace.defaultUser')}
        </div>
      );
    }
    return null;
  };
  return (
    <Native
      {...props}
      useSessions={(selector: (state: SessionList) => unknown) => selector(projection.sessions)}
      useWorkspaces={(selector: (state: WorkspaceList) => unknown) => selector(projection.workspaces)}
      useSessionStatus={(selector: (state: Map<string, ProjectedStatus>) => unknown) => selector(projection.status)}
      usePanelInfo={(selector: (state: SidebarPanelInfo) => unknown) =>
        selector(activeKey ? { ...panelInfo, activePanelId: null } : panelInfo)
      }
      startSession={(id: string) => (target(id) ? attempt(() => run(id, 'workspace.start')) : void chat.newWindows(id))}
      open={(id: string) => {
        const item = target(id);
        const row = item ? rowOf(item) : null;
        if (row) void chat.openRow(row);
        else props.open(id);
      }}
      requestSessionRename={rename}
      renameWorkspace={(id: string, title: string) =>
        target(id) ? attempt(() => run(id, 'workspace.rename', { title })) : props.renameWorkspace(id, title)
      }
      deleteWorkspace={(id: string) =>
        target(id) ? attempt(() => run(id, 'workspace.delete')) : props.deleteWorkspace(id)
      }
      insertWorkspaceBefore={async (id: string, before: string) => {
        if (id === before) return;
        const reordered = reorderWorkspace(projection.workspaces.items, projection.targets, id, before);
        if (target(id)) await run(id, 'workspace.reorder', { beforeId: reordered.beforeId });
        else if (reordered.beforeId) await props.insertWorkspaceBefore(id, reordered.beforeId);
        chat.setWorkspaceOrder(reordered.order);
      }}
      unarchiveSession={(id: string) => (target(id) ? run(id, 'unarchive') : props.unarchiveSession(id))}
      searchSessions={async (query: string, signal?: AbortSignal) => {
        const results = await Promise.all([
          props.searchSessions(query, signal),
          ...entries
            .filter((entry) => entry.ready)
            .map(async (entry) => {
              const value = (await chat.remote(entry, 'search', { query })) as SearchResults;
              return {
                ...value,
                items: value.items.map((hit) => ({
                  ...hit,
                  sessionId: remoteId(entry, 'session', hit.sessionId),
                })),
              };
            }),
        ]);
        if (signal?.aborted) throw new DOMException(ct('ui.sidebar.searchCanceled'), 'AbortError');
        const items = results.flatMap((result) => result.items);
        return {
          items: items.slice(0, props.searchResultLimit),
          hasMore: items.length > props.searchResultLimit || results.some((result) => result.hasMore),
        };
      }}
      renderSlot={renderSlot}
    />
  );
}

/** Install the mirrored sidebar adapter; returns the disposer. */
export function installNativeSidebar(ctx: ClientContext, model: ClientModel): () => void {
  const panel = model as PanelModel;
  let release: (() => void) | null = null;
  let native: SlotEntry | undefined;
  let busy = false;
  const sync = (): void => {
    if (busy) return;
    busy = true;
    try {
      const candidate = ctx.slots
        .entries('sidebar.workspaces')
        .find((entry) => entry.locale === 'workspace' && entry.children?.['sidebar.workspaces.directoryFlow']);
      const enabled = model.state?.mode === 'windows-host';
      if (native === candidate && !!release === !!enabled) return;
      release?.();
      release = null;
      native = candidate;
      if (!enabled || !candidate) return;
      const prefix = 'dsh-wsl-native.';
      const mirror = mirrorChildren(ctx, candidate.children, prefix);
      const dispose = ctx.slots.register(
        {
          name: 'sidebar.workspaces',
          priority: -60,
          inject: candidate.inject,
          store: candidate.store,
          locale: candidate.locale,
          children: mirror.declarations,
        },
        (props: NativeSidebarProps) => (
          <NativeWorkspaceAdapter
            {...props}
            Native={candidate.component as React.ComponentType<Record<string, unknown>>}
            ctx={ctx}
            model={panel}
            prefix={prefix}
          />
        ),
      );
      const stopMirror = mirror.start();
      release = () => {
        stopMirror();
        dispose();
      };
    } finally {
      busy = false;
    }
  };
  const offModel = model.subscribe(sync);
  const offSlot = ctx.slots.subscribe('sidebar.workspaces', sync);
  sync();
  return () => {
    offModel();
    offSlot();
    release?.();
  };
}
