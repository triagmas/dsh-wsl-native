import { openWorkspace } from './workspace-session.js';
import { ct } from './i18n/client.js';
import type { ClientContext, HarnessResult, SearchHit, WorkspaceRow } from './client-types.js';

/** Workspace-level actions the panel may perform on the Windows host. */
export const WORKSPACE_ACTIONS = [
  'workspace.start',
  'workspace.rename',
  'workspace.delete',
  'workspace.reorder',
  'session.rename',
  'session.fork',
  'search',
] as const;

/** Every action accepted from an embedded guest or the Desktop mailbox. */
export const CONVERSATION_ACTIONS: ReadonlySet<string> = new Set([
  'refresh',
  'theme',
  'chrome',
  'navigate',
  'pin',
  'unpin',
  'archive',
  'unarchive',
  'handoff.read',
  'handoff.deliver',
  ...WORKSPACE_ACTIONS,
]);

/** Validate a user-supplied title. */
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\x00-\x1f]/.test(value)) {
    throw new Error(ct('client.invalidTitle'));
  }
  return value.trim();
}

/** Session actions that map onto one `uiWorkspace` method. */
const SESSION_ACTIONS: Readonly<Record<string, 'pinSession' | 'unpinSession' | 'archiveSession' | 'unarchiveSession'>> = {
  pin: 'pinSession',
  unpin: 'unpinSession',
  archive: 'archiveSession',
  unarchive: 'unarchiveSession',
};

/** Run one fixed host operation. Neither transport can invoke arbitrary methods. */
export async function workspaceCommand(
  ctx: ClientContext,
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  if (action === 'search') {
    const query = text(payload.query);
    if (!query || query.length > 2000) throw new Error(ct('client.searchTooLong'));
    const result = await ctx.sessions.search(query);
    if (!result.ok) throw new Error(result.error.message);
    return {
      items: result.value.items.slice(0, 20).map((item: SearchHit) => ({
        sessionId: item.sessionId,
        snippet: item.snippet.slice(0, 1000),
      })),
      hasMore: result.value.hasMore,
    };
  }
  if (action.startsWith('workspace.')) {
    const workspaces = ctx.workspaces.list.getSnapshot().items;
    const workspaceId = text(payload.workspaceId);
    if (!workspaces.some((item: WorkspaceRow) => item.workspaceId === workspaceId)) {
      throw new Error(ct('client.workspaceGone'));
    }
    if (action === 'workspace.start') {
      await openWorkspace(ctx, workspaceId);
      return undefined;
    }
    if (action === 'workspace.rename') {
      await ctx.workspaces.rename(workspaceId, title(payload.title));
      return undefined;
    }
    if (action === 'workspace.delete') {
      await ctx.workspaces.delete(workspaceId);
      return undefined;
    }
    if (action === 'workspace.reorder') {
      const beforeId = text(payload.beforeId) || undefined;
      if (beforeId !== undefined && !workspaces.some((item: WorkspaceRow) => item.workspaceId === beforeId)) {
        throw new Error(ct('client.targetWorkspaceGone'));
      }
      await ctx.workspaces.insertBefore(workspaceId, beforeId);
      return undefined;
    }
  }
  const sessionId = text(payload.sessionId);
  if (!ctx.sessions.list.getSnapshot().byId[sessionId]) throw new Error(ct('client.sessionGone'));
  if (action === 'session.rename') {
    const name = title(payload.title);
    const result: HarnessResult<unknown> = await ctx.sessions.using(
      sessionId,
      { source: 'workspaceOperation' },
      (reference) => reference.binding.session.rename(name),
    );
    if (!result.ok) throw new Error(result.error.message);
    return undefined;
  }
  if (action === 'session.fork') {
    const id = await ctx.uiWorkspace.forkSession(sessionId);
    ctx.uiWorkspace.openSession(id);
    return undefined;
  }
  const method = SESSION_ACTIONS[action];
  if (!method) throw new Error(ct('client.invalidConversationAction'));
  if (action === 'archive') {
    await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: payload.stopActivity === true });
    return undefined;
  }
  await ctx.uiWorkspace[method](sessionId);
  return undefined;
}
