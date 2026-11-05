import { openWorkspace } from './workspace-session.js';
import { acceptsMessage, catalogOf, CONVERSATION_PROTOCOL } from './conversation-protocol.js';
import { openProject } from './client-session.js';
import { createDesktopMailbox, DESKTOP_MAILBOX, type DesktopMailbox } from './desktop-mailbox.js';
import { workspaceCommand } from './workspace-commands.js';
import { createWorkHandoff } from './work-handoff.js';
import { ct } from './i18n/client.js';
import type { Catalog, ClientContext, ClientModel, GuestEvent, HandoffRecord, PanelApi } from './client-types.js';

/** Guest state exposed to the panel menu. */
export interface GuestState {
  compact: boolean;
  returnWindows(): void;
  toggleSidebar(): void;
  publish(force?: boolean): void;
  dispose?(): void;
}



/** Embed instructions resolved from the handoff fragment. */
export interface GuestEmbed {
  channel: string;
  parentOrigin: string;
  transport?: 'desktop';
}

/** Result of adopting a verified handoff. */
interface AdoptedSettings {
  settings: { directory: string };
}

/**
 * Called only after environment/adopt has verified the launcher's signed handoff.
 * The guest forwards navigation metadata and fixed host commands; it never
 * evaluates code received from the parent window.
 */
export function startConversationGuest(
  ctx: ClientContext,
  model: ClientModel,
  api: PanelApi,
  embed: GuestEmbed,
): void {
  const desktop = embed.transport === 'desktop';
  if ((!desktop && window.parent === window) || model.guest !== undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCatalog = '';
  let stopped = false;
  let navigation = new AbortController();
  const handoff = createWorkHandoff(ctx);
  const endpoint = { origin: embed.parentOrigin, source: window.parent, channel: embed.channel };
  const mailbox: DesktopMailbox | null = desktop
    ? createDesktopMailbox(embed.channel, command)
    : null;
  if (mailbox) {
    Object.defineProperty(window, DESKTOP_MAILBOX, { value: mailbox.api, configurable: true });
  }
  const send = (type: string, value: Record<string, unknown> = {}): void => {
    if (mailbox) {
      mailbox.publish(type, value as { catalog?: Catalog });
      return;
    }
    endpoint.source.postMessage(
      { protocol: CONVERSATION_PROTOCOL, channel: embed.channel, type, ...value },
      endpoint.origin,
    );
  };
  const publish = (force = false): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      const catalog = catalogOf(ctx);
      const serialized = JSON.stringify(catalog);
      if (force || serialized !== lastCatalog) {
        lastCatalog = serialized;
        send('catalog', { catalog });
      }
    }, 50);
  };
  const guest: GuestState = {
    compact: true,
    returnWindows() {
      send('return');
    },
    toggleSidebar() {
      send('sidebar');
    },
    publish,
  };
  model.guest = guest;
  document.documentElement.setAttribute('data-dsh-wsl-guest', '');

  async function command(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (action === 'handoff.read' || action === 'handoff.deliver') {
      const value = await handoff(action, payload);
      publish(true);
      return value;
    }
    if (action === 'refresh') {
      publish(true);
      return undefined;
    }
    if (action === 'theme') {
      document.body.toggleAttribute('data-ds-dark-theme', payload.dark === true);
      document.documentElement.style.colorScheme = payload.dark === true ? 'dark' : 'light';
      const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
      for (const item of tokens.slice(0, 256)) {
        if (!Array.isArray(item)) continue;
        const [name, value] = item as [unknown, unknown];
        if (
          typeof name === 'string' &&
          /^--(?:ds|dsw|dsh)-[\w-]+$/.test(name) &&
          typeof value === 'string' &&
          value.length < 500
        ) {
          document.body.style.setProperty(name, value);
        }
      }
      return undefined;
    }
    if (action === 'chrome') {
      guest.compact = true;
      if (payload.panel === 'plugins' || payload.panel === null) ctx.layout.selectPanel(payload.panel);
      model.emit();
      return undefined;
    }
    if (action === 'navigate') {
      navigation.abort();
      navigation = new AbortController();
      const signal = navigation.signal;
      const sessionId = text(payload.sessionId);
      if (sessionId) {
        const row = ctx.sessions.list.getSnapshot().byId[sessionId];
        if (!row || row.parentId || ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(row.id)) {
          throw new Error(ct('client.sessionArchived'));
        }
        ctx.uiWorkspace.openSession(row.id);
      } else {
        const record = payload.handoff as HandoffRecord | undefined;
        if (!record) throw new Error(ct('client.missingHandoff'));
        const result = (await api('environment/adopt', record as unknown as Record<string, unknown>)) as AdoptedSettings;
        if (signal.aborted) return undefined;
        if (payload.create) {
          const workspace = await ctx.workspaces.create({ path: result.settings.directory });
          if (signal.aborted) return undefined;
          await openWorkspace(ctx, workspace.workspaceId, signal);
        } else {
          await openProject(ctx, result.settings.directory, signal);
        }
      }
      publish(true);
      return undefined;
    }
    const value = await workspaceCommand(ctx, action, payload);
    publish(true);
    return value;
  }

  const receive = (event: GuestEvent): void => {
    if (!acceptsMessage(event, endpoint) || event.data?.type !== 'request') return;
    const { id, action, payload } = event.data;
    if (typeof id !== 'string' || id.length > 100 || typeof action !== 'string') return;
    void command(action, payload).then(
      (value) => send('result', { id, ok: true, value }),
      (error: Error) => send('result', { id, ok: false, error: String(error.message).slice(0, 1000) }),
    );
  };
  if (!desktop) window.addEventListener('message', receive as unknown as EventListener);
  const disposers = [
    ctx.sessions.list.subscribe(() => publish()),
    ctx.workspaces.list.subscribe(() => publish()),
    ctx.connection.state.subscribe(() => publish()),
  ];
  publish(true);
  model.emit();
  guest.dispose = () => {
    stopped = true;
    navigation.abort();
    if (timer) clearTimeout(timer);
    window.removeEventListener('message', receive as unknown as EventListener);
    mailbox?.dispose();
    if (mailbox && (window as unknown as Record<string, unknown>)[DESKTOP_MAILBOX] === mailbox.api) {
      delete (window as unknown as Record<string, unknown>)[DESKTOP_MAILBOX];
    }
    for (const dispose of disposers) dispose();
    document.documentElement.removeAttribute('data-dsh-wsl-guest');
  };
}
