import { appOrigin, localOrigin, readHandoff, DESKTOP_ORIGIN } from './handoff.js';
import { ct } from './i18n/client.js';
import type {
  Catalog,
  CatalogRow,
  CatalogWorkspace,
  ClientContext,
  EnvironmentSettings,
  GuestEvent,
  GuestMessage,
} from './client-types.js';

export const CONVERSATION_PROTOCOL = 'dsh-wsl-conversation/1';
export const CONVERSATION_PANEL = 'dsh-wsl-conversation';
const CHANNEL = /^[a-zA-Z0-9-]{32,64}$/;

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');

/** Stable identity of one Linux environment inside the panel. */
export function conversationKey(settings: EnvironmentSettings): string {
  return JSON.stringify([settings.distro || '', settings.user || '']);
}

/** Rewrite a signed handoff URL for same-window embedding. */
export function embeddedUrl(url: string, channel: string, parentOrigin: string | null): string {
  const destination = new URL(url);
  const handoff = readHandoff(destination.hash);
  const parent = appOrigin(parentOrigin);
  if (!localOrigin(destination.origin) || !parent || !CHANNEL.test(channel) || !handoff?.proof) {
    throw new Error(ct('client.unverifiableTarget'));
  }
  if (handoff.parentOrigin !== parent) throw new Error(ct('client.unverifiableTarget'));
  const payload = JSON.parse(decodeURIComponent(destination.hash.slice(9))) as Record<string, unknown>;
  const embed = {
    channel,
    ...(parent === DESKTOP_ORIGIN ? { transport: 'desktop' as const } : {}),
  };
  destination.hash = 'dsh-wsl=' + encodeURIComponent(JSON.stringify({ ...payload, embed }));
  return destination.href;
}

/** Embed request carried inside a verified handoff fragment. */
export interface Embed {
  channel: string;
  parentOrigin: string;
  transport?: 'desktop';
}

/** Read the embed request from a verified handoff fragment. */
export function readEmbed(hash: string | null | undefined): Embed | null {
  const handoff = readHandoff(hash);
  if (!handoff?.proof || !handoff.parentOrigin || !hash) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(hash.slice(9))) as { embed?: Partial<Embed> };
    const embed = parsed.embed;
    if (!embed || !CHANNEL.test(embed.channel ?? '')) return null;
    if (embed.transport !== undefined && (embed.transport !== 'desktop' || handoff.parentOrigin !== DESKTOP_ORIGIN)) {
      return null;
    }
    return {
      channel: embed.channel as string,
      parentOrigin: handoff.parentOrigin,
      ...(embed.transport ? { transport: embed.transport } : {}),
    };
  } catch {
    return null;
  }
}

/** Endpoint identity one guest message must match. */
export interface Endpoint {
  origin: string;
  source: unknown;
  channel: string;
}

const MESSAGE_TYPES = ['catalog', 'request', 'result', 'return', 'sidebar'];

/** Accept only messages from the verified same-window endpoint. */
export function acceptsMessage(event: GuestEvent, endpoint: Endpoint): boolean {
  const data = event.data;
  return (
    !!endpoint.source &&
    event.source === endpoint.source &&
    event.origin === endpoint.origin &&
    !!localOrigin(event.origin) &&
    CHANNEL.test(endpoint.channel || '') &&
    data?.protocol === CONVERSATION_PROTOCOL &&
    data.channel === endpoint.channel &&
    MESSAGE_TYPES.includes(data.type ?? '')
  );
}

/** Catalogs contain bounded navigation metadata, never prompts, credentials or files. */
export function cleanCatalog(value: unknown): Catalog | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as {
    rows?: unknown;
    workspaces?: unknown;
    selectedId?: unknown;
    connected?: unknown;
    phase?: unknown;
  };
  if (!Array.isArray(source.rows) || source.rows.length > 5000) return null;
  const seen = new Set<string>();
  const rows: CatalogRow[] = [];
  for (const entry of source.rows) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || row.id.length > 200 || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({
      id: row.id,
      title: text(row.title, 500),
      cwd: text(row.cwd, 4096),
      workspaceId: text(row.workspaceId, 200),
      workspaceTitle: text(row.workspaceTitle, 500),
      running: row.running === true,
      blank: row.blank === true,
      pinned: row.pinned === true,
      archived: row.archived === true,
      updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    });
  }
  const workspaceIds = new Set<string>();
  const workspaces: CatalogWorkspace[] = [];
  for (const item of (Array.isArray(source.workspaces) ? source.workspaces : []).slice(0, 2048)) {
    if (!item || typeof item !== 'object') continue;
    const workspace = item as Record<string, unknown>;
    if (
      typeof workspace.workspaceId !== 'string' ||
      !workspace.workspaceId ||
      workspace.workspaceId.length > 200 ||
      workspaceIds.has(workspace.workspaceId)
    ) {
      continue;
    }
    workspaceIds.add(workspace.workspaceId);
    workspaces.push({
      workspaceId: workspace.workspaceId,
      path: text(workspace.path, 4096),
      title: text(workspace.title, 500),
      sessionIds: [
        ...new Set((Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).filter((id): id is string => typeof id === 'string' && seen.has(id))),
      ],
      createdAt: text(workspace.createdAt, 100),
      updatedAt: text(workspace.updatedAt, 100),
    });
  }
  // Older guests do not send empty workspaces. Preserve their navigation until upgraded.
  for (const row of rows) {
    if (row.workspaceId && !workspaceIds.has(row.workspaceId)) {
      workspaceIds.add(row.workspaceId);
      workspaces.push({
        workspaceId: row.workspaceId,
        path: row.cwd,
        title: row.workspaceTitle,
        sessionIds: rows.filter((item) => item.workspaceId === row.workspaceId).map((item) => item.id),
        createdAt: '',
        updatedAt: '',
      });
    }
  }
  return {
    rows,
    workspaces,
    selectedId: rows.some((row) => row.id === source.selectedId) ? (source.selectedId as string) : null,
    connected: source.connected === true,
    phase: source.phase === 'ready' ? 'ready' : 'loading',
  };
}

/** Publish the local catalog in the guest protocol shape. */
export function catalogOf(ctx: ClientContext): Catalog {
  const sessions = ctx.sessions.list.getSnapshot();
  const workspaces = ctx.workspaces.list.getSnapshot();
  const owners = new Map<string, CatalogWorkspace>();
  for (const workspace of workspaces.items) {
    for (const id of workspace.sessionIds) {
      owners.set(id, {
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        title: workspace.title ?? '',
        sessionIds: [],
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt ?? '',
      });
    }
  }
  const archived = new Set(workspaces.archivedSessionIds);
  const pinned = new Set(workspaces.pinnedSessionIds);
  const rows = sessions.ids
    .map((id) => sessions.byId[id])
    .filter((row) => row !== undefined && !row.parentId)
    .slice(0, 5000);
  const catalog = cleanCatalog({
    phase: sessions.phase === 'ready' && workspaces.phase === 'ready' ? 'ready' : 'loading',
    connected: ctx.connection.state.getSnapshot() === 'connected',
    workspaces: workspaces.items,
    selectedId: rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id,
    rows: rows.map((row) => ({
      id: row?.id,
      title: row?.title || (row?.blank ? ct('client.newConversation') : row?.displayTitle),
      cwd: row?.cwd,
      workspaceId: owners.get(row?.id ?? '')?.workspaceId,
      workspaceTitle: owners.get(row?.id ?? '')?.title || '',
      running: row?.running,
      blank: row?.blank,
      updatedAt: row?.updatedAt,
      archived: archived.has(row?.id ?? ''),
      pinned: pinned.has(row?.id ?? ''),
    })),
  });
  return catalog ?? { rows: [], workspaces: [], selectedId: null, connected: false, phase: 'loading' };
}

/** Row shape the unified sidebar renders. */
export interface ConversationRow extends CatalogRow {
  environment: { key: string; settings: EnvironmentSettings; catalog?: Catalog | null } | null;
  key: string;
}

/** Merge local and remote rows into the unified conversation list. */
export function conversationRows(
  local: Catalog | null,
  environments: { key: string; settings: EnvironmentSettings; catalog?: Catalog | null }[],
  options: { filter?: 'all' | 'windows' | 'wsl'; query?: string; archived?: boolean } = {},
): ConversationRow[] {
  const { filter = 'all', query = '', archived = false } = options;
  const all: ConversationRow[] = (local?.rows ?? []).map((row) => ({
    ...row,
    environment: null,
    key: JSON.stringify(['windows', row.id]),
  }));
  for (const environment of environments) {
    for (const row of environment.catalog?.rows ?? []) {
      all.push({ ...row, environment, key: JSON.stringify(['wsl', environment.key, row.id]) });
    }
  }
  const needle = query.trim().toLocaleLowerCase();
  return all
    .filter(
      (row) =>
        row.archived === archived &&
        (filter === 'all' || (filter === 'wsl') === !!row.environment) &&
        (!needle ||
          [row.title, row.cwd, row.environment?.settings.distro ?? '']
            .join(' ')
            .toLocaleLowerCase()
            .includes(needle)),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
    );
}

export type { GuestMessage };
