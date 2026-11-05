import { connectWorkspace } from './workspace-session.js';
import { ct } from './i18n/client.js';
import type { ClientContext, EnvironmentSettings } from './client-types.js';

/** Writer installed by the mounted native input for one session. */
export interface DraftWriter {
  getDraft(): string;
  setDraft(value: string): void;
}

/** Per-context registry of draft writers and their waiters. */
interface DraftRegistry {
  writers: Map<string, DraftWriter>;
  waiting: Map<string, Set<(writer: DraftWriter) => void>>;
}

const draftBindings = new WeakMap<ClientContext, DraftRegistry>();

function draftRegistry(ctx: ClientContext): DraftRegistry {
  let registry = draftBindings.get(ctx);
  if (!registry) {
    registry = { writers: new Map(), waiting: new Map() };
    draftBindings.set(ctx, registry);
  }
  return registry;
}

/**
 * A mounted slot shares DSH's own per-session persisted store. Waiting for it
 * avoids writing before the native input has installed its draft mirror.
 */
export function bindHandoffDraft(
  ctx: ClientContext,
  sessionId: string,
  writer: DraftWriter,
): () => void {
  const registry = draftRegistry(ctx);
  registry.writers.set(sessionId, writer);
  for (const ready of registry.waiting.get(sessionId) ?? []) ready(writer);
  return () => {
    if (registry.writers.get(sessionId) === writer) registry.writers.delete(sessionId);
  };
}

function mountedDraft(ctx: ClientContext, sessionId: string): Promise<DraftWriter> {
  const registry = draftRegistry(ctx);
  const writer = registry.writers.get(sessionId);
  if (writer) return Promise.resolve(writer);
  return new Promise((resolve, reject) => {
    const waiting = registry.waiting.get(sessionId) ?? new Set<(value: DraftWriter) => void>();
    const timer = setTimeout(() => {
      clean();
      reject(new Error(ct('client.targetInputNotReady')));
    }, 10000);
    const ready = (value: DraftWriter): void => {
      clean();
      resolve(value);
    };
    function clean(): void {
      clearTimeout(timer);
      waiting.delete(ready);
      if (!waiting.size) registry.waiting.delete(sessionId);
    }
    waiting.add(ready);
    registry.waiting.set(sessionId, waiting);
  });
}

/** One recorded event from a session transcript. */
export interface TranscriptEntry {
  type: string;
  event?: {
    type?: string;
    data?: unknown;
  };
}

/** Extract the most recent user and assistant text as handoff material. */
export function recentConversation(entries: readonly TranscriptEntry[], maxChars = 18000): string {
  const messages: string[] = [];
  for (const entry of entries) {
    const event = entry.event;
    if (entry.type !== 'event' || !event || !['user/message', 'assistant/message'].includes(event.type ?? '')) continue;
    const source = event.type === 'user/message' ? event.data : (event.data as { message?: unknown } | undefined)?.message;
    const content = (source as { content?: unknown } | undefined)?.content;
    const parts = Array.isArray(content) ? content : [];
    const text = parts
      .filter((part): part is { type: string; text: string } => {
        const item = part as { type?: unknown; text?: unknown };
        return item.type === 'text' && typeof item.text === 'string';
      })
      .map((part) => part.text)
      .join('\n');
    if (text.trim()) messages.push(`${event.type === 'user/message' ? ct('client.roleUser') : ct('client.roleAssistant')}:\n${text}`);
  }
  return messages.slice(-8).join('\n\n').slice(-maxChars);
}

/** Source conversation a handoff starts from. */
export interface HandoffSource {
  entry?: { settings: EnvironmentSettings } | null;
  row: { title?: string; cwd?: string };
  id: string;
}

/** Build the handoff prompt text. */
export function handoffText(source: HandoffSource, notes: string, recent = ''): string {
  const system = source.entry
    ? `WSL · ${source.entry.settings.distro} · ${source.entry.settings.user || ct('client.defaultUser')}`
    : 'Windows';
  const cwd = source.row.cwd ?? '';
  const alternate =
    source.entry && cwd.startsWith('/')
      ? `\\\\wsl.localhost\\${source.entry.settings.distro}${cwd.replaceAll('/', '\\')}`
      : /^[a-z]:[\\/]/i.test(cwd)
        ? '/mnt/' + cwd[0]?.toLowerCase() + cwd.slice(2).replaceAll('\\', '/')
        : '';
  return ct('client.handoffText', {
    system,
    title: source.row.title || ct('client.newConversation'),
    id: source.id,
    cwd: cwd || ct('client.notSpecified'),
    alternate: alternate ? `\n${ct('client.handoffAlternate', { path: alternate })}` : '',
    notes: notes.trim(),
    recent: recent ? `\n\n${ct('client.handoffRecent', { text: recent })}` : '',
  });
}

/** Result of a completed handoff. */
export interface HandoffResult {
  sessionId: string;
  mode: 'draft' | 'send';
}

/** Persisted record preventing duplicate delivery. */
interface HandoffRecord {
  sessionId: string;
  mode?: 'draft' | 'send';
  done?: boolean;
  pending?: boolean;
  time?: number;
}

/** Input surface DSH exposes for one session. */
interface ConversationInput {
  for(binding: unknown): {
    state: { getSnapshot(): { draft: string; attachmentIds: unknown[]; phase: string } };
    setDraft(value: string): void;
  };
}

/**
 * User-initiated transfers are addressed to a specific session. There is no
 * watcher that forwards subsequent messages or repeatedly prompts an agent.
 */
export function createWorkHandoff(
  ctx: ClientContext,
  storage: Storage | undefined = globalThis.localStorage,
): (action: string, payload: Record<string, unknown>) => Promise<unknown> {
  const inFlight = new Map<string, Promise<HandoffResult>>();
  return async (action, payload) => {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (action === 'handoff.read') {
      const sessionId = text(payload.sessionId);
      if (!ctx.sessions.list.getSnapshot().byId[sessionId]) throw new Error(ct('client.sourceSessionGone'));
      const result = await ctx.sessions.using(sessionId, { source: 'workspaceOperation' }, (reference) => {
        const source = (reference.binding as unknown as { eventSource: { getSnapshot(): { entries: TranscriptEntry[] } } })
          .eventSource;
        return Promise.resolve({ ok: true as const, value: { text: recentConversation(source.getSnapshot().entries) } });
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    const transferId = text(payload.transferId);
    const mode = payload.mode === 'draft' || payload.mode === 'send' ? payload.mode : undefined;
    if (action !== 'handoff.deliver' || !/^[a-f0-9-]{36}$/.test(transferId) || !mode) {
      throw new Error(ct('client.invalidHandoff'));
    }
    const body = text(payload.text);
    if (!body.trim() || body.length > 24000) throw new Error(ct('client.invalidHandoff'));
    const key = 'dsh-wsl-native:handoff:' + transferId;
    const existing = inFlight.get(key);
    if (existing) return existing;
    let record: HandoffRecord | null = null;
    try {
      record = JSON.parse(storage?.getItem(key) ?? 'null') as HandoffRecord | null;
    } catch {
      // Unavailable storage only disables the duplicate guard.
    }
    if (record?.done && record.sessionId && record.mode) {
      return { sessionId: record.sessionId, mode: record.mode };
    }
    if (record?.pending) throw new Error(ct('client.handoffPending', { session: record.sessionId }));
    const remember = (value: HandoffRecord): void => {
      record = value;
      try {
        storage?.setItem(key, JSON.stringify(value));
      } catch {
        // Storage limits do not block the transfer itself.
      }
    };
    const operation = (async (): Promise<HandoffResult> => {
      let sessionId = record?.sessionId || text(payload.sessionId);
      if (!sessionId) {
        const workspaceId = text(payload.workspaceId);
        if (!ctx.workspaces.list.getSnapshot().items.some((item) => item.workspaceId === workspaceId)) {
          throw new Error(ct('client.chooseWorkspace'));
        }
        sessionId = await connectWorkspace(ctx, workspaceId);
        remember({ sessionId });
      }
      if (!ctx.sessions.list.getSnapshot().byId[sessionId]) await ctx.sessions.refresh();
      if (ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)) {
        throw new Error(ct('client.unarchiveTarget'));
      }
      let failure: Error | undefined;
      await ctx.sessions.using(sessionId, { source: 'workspaceOperation' }, async (reference) => {
        if (mode === 'draft') {
          const conversation = ctx.get('conversation') as { input?: ConversationInput } | undefined;
          if (!conversation?.input) throw new Error(ct('client.noInputSurface'));
          ctx.uiWorkspace.openSession(sessionId as string);
          const writer = await mountedDraft(ctx, sessionId as string);
          const input = conversation.input.for(reference.binding.ctx);
          const snapshot = input.state.getSnapshot();
          if (
            snapshot.draft.trim() ||
            writer.getDraft().trim() ||
            snapshot.attachmentIds.length ||
            snapshot.phase !== 'plain'
          ) {
            throw new Error(ct('client.targetBusy'));
          }
          remember({ sessionId: sessionId as string, mode, pending: true });
          writer.setDraft(body);
          input.setDraft(body);
          return { ok: true as const, value: undefined };
        }
        remember({ sessionId: sessionId as string, mode, pending: true });
        const sendResult = await reference.binding.session.prompt([{ type: 'text', text: body }], 'queue');
        if (!sendResult.ok) {
          failure = new Error(ct('client.handoffUnconfirmed', { error: sendResult.error.message }));
          throw failure;
        }
        ctx.uiWorkspace.openSession(sessionId as string);
        return { ok: true as const, value: undefined };
      }).catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
      remember({ sessionId, mode, done: true, time: Date.now() });
      return { sessionId, mode };
    })();
    inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(key);
    }
  };
}
