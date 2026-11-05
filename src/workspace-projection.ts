import { ct } from './i18n/client.js';
import type { Catalog, CatalogRow, CatalogWorkspace, SessionList, WorkspaceList } from './client-types.js';

/** One Linux environment attached to the Windows sidebar. */
export interface ProjectedEntry {
  key: string;
  catalog?: Catalog | null;
}

/** A row that exists only in the Windows projection. */
export interface RemoteTarget {
  entry: ProjectedEntry;
  id: string;
  kind: 'session' | 'workspace';
  row?: CatalogRow;
  workspace?: CatalogWorkspace;
}

/** Status entry for the sidebar store. */
export interface ProjectedStatus {
  running: boolean;
  completionUnread: boolean;
}

/** Result of projecting Linux catalogs into the Windows sidebar. */
export interface Projection {
  sessions: SessionList;
  workspaces: WorkspaceList;
  status: Map<string, ProjectedStatus>;
  targets: Map<string, RemoteTarget>;
}

/** Virtual ids exist only in the Windows sidebar. Real host ids are never changed. */
export const remoteId = (entry: ProjectedEntry, kind: string, id: string): string =>
  'dsh-wsl:' + JSON.stringify([entry.key, kind, id]);

/** Project remote sessions and workspaces into local snapshots. */
export function projectWorkspaces(
  localSessions: SessionList,
  localWorkspaces: WorkspaceList,
  localStatus: Map<string, ProjectedStatus>,
  entries: ProjectedEntry[],
  activeKey: string | null,
  order: string[] = [],
): Projection {
  const sessions: SessionList = { ...localSessions, ids: [...localSessions.ids], byId: { ...localSessions.byId } };
  if (activeKey) {
    for (const id of sessions.ids) {
      const row = sessions.byId[id];
      if (row?.retainedBy?.mainView) {
        sessions.byId[id] = { ...row, retainedBy: { ...row.retainedBy, mainView: 0 } };
      }
    }
  }
  const workspaces: WorkspaceList = {
    ...localWorkspaces,
    items: [...localWorkspaces.items],
    pinnedSessionIds: [...localWorkspaces.pinnedSessionIds],
    archivedSessionIds: [...localWorkspaces.archivedSessionIds],
  };
  const status = new Map(localStatus);
  const targets = new Map<string, RemoteTarget>();
  for (const entry of entries) {
    for (const row of entry.catalog?.rows ?? []) {
      const id = remoteId(entry, 'session', row.id);
      targets.set(id, { entry, id: row.id, row, kind: 'session' });
      sessions.ids.push(id);
      sessions.byId[id] = {
        id,
        title: row.title,
        displayTitle: row.title,
        cwd: row.cwd,
        blank: row.blank,
        running: row.running,
        updatedAt: row.updatedAt,
        retainedBy: {
          mainView: activeKey === entry.key && entry.catalog?.selectedId === row.id ? 1 : 0,
        },
      };
      status.set(id, { running: row.running, completionUnread: false });
      if (row.pinned) workspaces.pinnedSessionIds.push(id);
      if (row.archived) workspaces.archivedSessionIds.push(id);
    }
    for (const workspace of entry.catalog?.workspaces ?? []) {
      const id = remoteId(entry, 'workspace', workspace.workspaceId);
      targets.set(id, { entry, id: workspace.workspaceId, workspace, kind: 'workspace' });
      workspaces.items.push({
        ...workspace,
        workspaceId: id,
        sessionIds: workspace.sessionIds.map((session) => remoteId(entry, 'session', session)),
      });
    }
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  workspaces.items.sort(
    (a, b) => (rank.get(a.workspaceId) ?? Number.POSITIVE_INFINITY) - (rank.get(b.workspaceId) ?? Number.POSITIVE_INFINITY),
  );
  return { sessions, workspaces, status, targets };
}

/** Compute the order after moving one workspace, with its neighbor for remote hosts. */
export function reorderWorkspace(
  items: { workspaceId: string }[],
  targets: Map<string, RemoteTarget>,
  id: string,
  before?: string,
): { order: string[]; beforeId: string | undefined } {
  if (
    !items.some((item) => item.workspaceId === id) ||
    (before !== undefined && !items.some((item) => item.workspaceId === before))
  ) {
    throw new Error(ct('client.workspaceOrderChanged'));
  }
  const order = items.map((item) => item.workspaceId);
  if (id === before) return { order, beforeId: before };
  order.splice(order.indexOf(id), 1);
  order.splice(before === undefined ? order.length : order.indexOf(before), 0, id);
  const environment = targets.get(id)?.entry.key;
  const next = order
    .slice(order.indexOf(id) + 1)
    .find((other) => targets.get(other)?.entry.key === environment);
  return { order, beforeId: next === undefined ? undefined : (targets.get(next)?.id ?? next) };
}
