import type { ClientContext, WorkspaceList } from './client-types.js';

/** In-flight workspace connection per panel context. */
const connecting = new WeakMap<ClientContext, Map<string, Promise<string>>>();

/**
 * Native DSH reuses blank sessions, including ones whose preset was removed.
 * Recover only that refusal, with a fresh identity and the host's current default.
 */
export function connectWorkspace(ctx: ClientContext, workspaceId: string): Promise<string> {
  let pending = connecting.get(ctx);
  if (!pending) {
    pending = new Map<string, Promise<string>>();
    connecting.set(ctx, pending);
  }
  const existing = pending.get(workspaceId);
  if (existing) return existing;
  const operation = Promise.resolve()
    .then(async () => {
      try {
        return await ctx.uiWorkspace.connectWorkspace(workspaceId);
      } catch (error) {
        const failure = error as { name?: string; rpcError?: { code?: string } };
        if (failure?.name !== 'SessionCreateError' || failure.rpcError?.code !== 'agent-preset/not-found') throw error;
        return ctx.sessions.create({ workspaceId });
      }
    })
    .finally(() => pending.delete(workspaceId));
  pending.set(workspaceId, operation);
  return operation;
}

/** Open one workspace row and select its session. */
export async function openWorkspace(
  ctx: ClientContext,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string> {
  const navigation = ctx.layout.beginNavigation();
  const sessionId = await connectWorkspace(ctx, workspaceId);
  if (!navigation.aborted && !signal?.aborted) ctx.uiWorkspace.openSession(sessionId);
  return sessionId;
}

/** Start a new session, preferring the most recently used workspace. */
export async function startSession(ctx: ClientContext, workspaceId?: string): Promise<void> {
  const workspaces: WorkspaceList = ctx.workspaces.list.getSnapshot();
  const sessions = ctx.sessions.list.getSnapshot();
  const current = sessions.ids.find((id) => (sessions.byId[id]?.retainedBy?.mainView ?? 0) > 0);
  let target =
    workspaceId ??
    workspaces.items.find((item) => current !== undefined && item.sessionIds.includes(current))?.workspaceId;
  if (target === undefined && workspaces.phase === 'ready' && sessions.phase === 'ready') {
    let latest = Number.NEGATIVE_INFINITY;
    for (const workspace of workspaces.items) {
      const times = workspace.sessionIds
        .map((id) => sessions.byId[id]?.updatedAt)
        .filter((value): value is number => Number.isFinite(value));
      const time = times.length ? Math.max(...times) : Date.parse(workspace.createdAt);
      if (target === undefined || time > latest) {
        target = workspace.workspaceId;
        latest = time;
      }
    }
  }
  if (target === undefined) ctx.uiWorkspace.startSession();
  else await openWorkspace(ctx, target);
}
