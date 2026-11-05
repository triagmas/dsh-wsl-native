import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Button,
  MenuItemButton,
  StateDot,
  IconPanelLeftOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { TerminalIcon } from './components.js';
import { useModel } from './page.js';
import { CONVERSATION_PANEL } from './conversation-protocol.js';
import { appOrigin } from './handoff.js';
import { mountDesktopView, type DesktopBridge, type ViewEntry } from './desktop-view.js';
import { CompactConversationList } from './sidebar.js';
import { installNativeWorkspaces } from './native-workspaces.js';
import { installNativeSidebar } from './native-sidebar.js';
import { WorkspaceDialogs } from './workspace-dialogs.js';
import { bindHandoffDraft } from './work-handoff.js';
import { ct } from './i18n/client.js';
import type { ClientContext, ClientModel, PanelApi } from './client-types.js';
import type { ConversationEntry } from './conversation-model.js';
import type { PanelModel } from './panel-types.js';

/** Store shape the conversation composer exposes to the handoff binding. */
interface DraftStore {
  draft: string;
}

/** Props passed by the Harness into `conversation.input.dock` entries. */
interface DraftBindingProps {
  ctx: ClientContext;
  sessionId: string;
  useStore: <T>(selector: (state: DraftStore) => T) => T;
  actions: { setDraft(text: string): void };
}

/** Keep the Linux composer draft in sync with the Windows handoff draft. */
function HandoffDraftBinding({ ctx, sessionId, useStore, actions }: DraftBindingProps) {
  const draft = useStore((state) => state.draft);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () =>
      bindHandoffDraft(ctx, sessionId, {
        getDraft: () => latest.current,
        setDraft: (text: string) => {
          latest.current = text;
          actions.setDraft(text);
        },
      }),
    [ctx, sessionId, actions],
  );
  return null;
}

/** Small "WSL" mark shown on Linux conversations. */
function WslMark({ distro, connected = true }: { distro?: string; connected?: boolean }) {
  return (
    <span className={`dsh-wsl-chat-mark${connected ? '' : ' is-offline'}`} title={`WSL · ${distro || 'Linux'}`}>
      <TerminalIcon size={12} />
      WSL
    </span>
  );
}

/** Placeholder that reserves the conversation area and offers a way out. */
export function ConversationTarget({ ctx, model }: { ctx: ClientContext; model: PanelModel }) {
  useModel(model);
  const ref = useRef<HTMLDivElement | null>(null);
  const chat = model.conversations;
  const ready = chat.entries.get(chat.activeKey ?? '')?.ready;
  useLayoutEffect(() => {
    chat.setAnchor(ref.current);
    return () => chat.setAnchor(null);
  }, [chat]);
  return (
    <div className="dsh-wsl-chat-target" ref={ref}>
      {!ready ? (
        <div className="dsh-wsl-chat-loading">
          <StateDot state="ongoing" />
          {ct('ui.conversations.connecting')}
          <Button variant="ghost" onClick={() => ctx.layout.selectPanel('dsh-wsl-native')}>
            {ct('ui.conversations.viewEnvironment')}
          </Button>
          <Button variant="ghost" onClick={() => chat.showWindows()}>
            {ct('ui.conversations.backToWindows')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Desktop-bridged conversation surface for the DSH Desktop transport. */
function DesktopSurface({ entry, model, visible }: { entry: ConversationEntry; model: PanelModel; visible: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const chat = model.conversations;
    const element = host.current;
    if (!element) return;
    const adapter = mountDesktopView({
      host: element,
      entry: {
        key: entry.key,
        origin: entry.origin ?? '',
        channel: entry.channel ?? '',
        url: entry.url ?? '',
        settings: entry.settings,
      } satisfies ViewEntry,
      bridge: window.dshDesktop?.browser as DesktopBridge,
      onMessage: (message) => chat.desktopMessage(entry, message),
      onError: (error) => chat.desktopError(entry, error),
    });
    entry.desktop = adapter;
    return () => {
      adapter.dispose();
      if (entry.desktop === adapter) entry.desktop = undefined;
    };
  }, [entry, model]);
  return (
    <div
      className="dsh-wsl-desktop-surface"
      ref={host}
      inert={!visible || !!entry.navigating}
      style={{ visibility: visible && entry.ready ? 'visible' : 'hidden' }}
    />
  );
}

/** One resident conversation frame, kept alive off-screen while another is active. */
function ResidentFrame({
  entry,
  model,
  visible,
  rect,
  ctx,
}: {
  entry: ConversationEntry;
  model: PanelModel;
  visible: boolean;
  rect: { top: number; left: number; width: number; height: number } | null;
  ctx: ClientContext;
}) {
  const chat = model.conversations;
  useEffect(() => {
    if (entry.ready || ['waiting', 'failed'].includes(entry.recovery?.phase ?? '')) return;
    const timer = setTimeout(() => chat.desktopError(entry, new Error(ct('ui.conversations.timeout'))), 45000);
    return () => clearTimeout(timer);
  }, [entry, entry.ready, entry.recovery, chat]);
  const failed = entry.recovery?.phase === 'failed';
  const selected = entry.catalog?.rows.find((row) => row.id === entry.catalog?.selectedId);
  return (
    <section
      className="dsh-wsl-resident"
      aria-label={ct('ui.conversations.frameLabel', { distro: entry.settings.distro })}
      aria-hidden={!visible}
      inert={!visible}
      style={
        visible && rect
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : {
              visibility: 'hidden',
              left: -20000,
              top: 0,
              width: rect?.width ?? 1000,
              height: rect?.height ?? 800,
            }
      }
    >
      <header className="dsh-wsl-chat-toolbar">
        <Button
          variant="ghost"
          icon={<IconPanelLeftOutlineRegular />}
          aria-label={ct('ui.conversations.toggleSidebar')}
          title={ct('ui.conversations.toggleSidebar')}
          onClick={() => ctx.layout.toggleSidebar()}
        />
        <WslMark distro={entry.settings.distro} connected={entry.catalog?.connected} />
        <span className="dsh-wsl-chat-context" title={selected?.cwd ?? entry.settings.directory}>
          {entry.settings.distro}
          <span> · {selected?.cwd?.split('/').filter(Boolean).at(-1) ?? 'Linux'}</span>
        </span>
        <div className="dsh-wsl-chat-toolbar-actions">
          <Button variant="ghost" onClick={() => void chat.newLinux(entry)}>
            {ct('ui.conversations.new')}
          </Button>
          <Button
            variant="ghost"
            disabled={!entry.ready || !selected}
            onClick={() => selected && chat.requestHandoff({ entry, id: selected.id, row: selected })}
          >
            {ct('ui.handoff.title')}
          </Button>
          <Button
            variant="ghost"
            disabled={!entry.ready}
            title={ct('ui.conversations.configHint')}
            onClick={() => chat.toggleChrome(entry)}
          >
            {entry.configOpen ? ct('ui.conversations.backToChat') : ct('ui.conversations.linuxConfig')}
          </Button>
        </div>
      </header>
      {chat.error && visible ? (
        <div role="alert" className="dsh-wsl-chat-notice">
          {chat.error}
        </div>
      ) : null}
      <div className="dsh-wsl-chat-frame-body">
        {entry.transport === 'desktop' ? (
          <DesktopSurface entry={entry} model={model} visible={visible} />
        ) : (
          <iframe
            key={entry.channel}
            title={ct('ui.conversations.frameTitle', { distro: entry.settings.distro })}
            src={entry.url ?? ''}
            ref={(element) => chat.bind(entry, element)}
            inert={!visible || !!entry.navigating}
            onError={() => chat.desktopError(entry, new Error(ct('ui.conversations.loadFailed')))}
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
            style={{ visibility: visible && entry.ready ? 'visible' : 'hidden' }}
          />
        )}
        {!entry.ready ? (
          <div className="dsh-wsl-chat-loading" role="status">
            {!failed ? <StateDot state="ongoing" /> : null}
            <span>
              {entry.recovery?.message ?? ct('ui.conversations.opening')}
              {entry.recovery && !failed ? ` (${entry.recovery.attempt}/3)` : ''}
            </span>
            {failed ? <Button onClick={() => void chat.reconnect(entry)}>{ct('ui.conversations.reconnect')}</Button> : null}
            <Button variant="ghost" onClick={() => chat.showWindows()}>
              {ct('ui.conversations.backToWindowsShort')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** All resident conversation frames plus the guest chrome sync. */
export function ConversationFrames({ ctx, model }: { ctx: ClientContext; model: PanelModel }) {
  useModel(model);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const chat = model.conversations;
  const visible = chat.visible();
  const anchor = chat.anchor;
  useLayoutEffect(() => {
    if (!anchor) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = anchor.getBoundingClientRect();
        setRect({
          top: box.top,
          left: box.left,
          width: Math.max(0, document.documentElement.clientWidth - box.left),
          height: box.height,
        });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf);
    };
  }, [anchor]);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-dsh-wsl-conversation', visible);
    return () => document.documentElement.removeAttribute('data-dsh-wsl-conversation');
  }, [visible]);
  if (model.state?.mode !== 'windows-host') return null;
  return (
    <>
      {[...chat.entries.values()]
        .filter((entry) => entry.url)
        .map((entry) => (
          <ResidentFrame
            key={entry.key + (entry.channel ?? '')}
            entry={entry}
            model={model}
            ctx={ctx}
            visible={visible && !!anchor && chat.activeKey === entry.key}
            rect={rect}
          />
        ))}
    </>
  );
}

/** Mirror the guest page's own chrome onto the host shell grid. */
export function GuestChrome({ model }: { model: PanelModel }) {
  useModel(model);
  const ref = useRef<HTMLSpanElement | null>(null);
  const compact = model.guest?.compact === true;
  useLayoutEffect(() => {
    const frame = ref.current?.closest('[data-shell-overlay]')?.parentElement;
    if (!(frame instanceof HTMLElement) || !model.guest) return;
    const right = frame.querySelector(':scope > [data-rightbar-col]');
    const center = right?.previousElementSibling;
    const sidebar = center?.previousElementSibling;
    sidebar?.setAttribute('data-dsh-wsl-guest-sidebar', '');
    center?.setAttribute('data-dsh-wsl-guest-center', '');
    frame.toggleAttribute('data-dsh-wsl-embedded', compact);
    const update = () => {
      const match = /minmax\(0px,\s*([\d.]+px)\)\s*$/.exec(frame.style.gridTemplateColumns);
      const width = match?.[1] ?? '0px';
      if (frame.style.getPropertyValue('--dsh-wsl-right-track') !== width) {
        frame.style.setProperty('--dsh-wsl-right-track', width);
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(frame, { attributes: true, attributeFilter: ['style'] });
    update();
    return () => {
      observer.disconnect();
      frame.removeAttribute('data-dsh-wsl-embedded');
      frame.style.removeProperty('--dsh-wsl-right-track');
      sidebar?.removeAttribute('data-dsh-wsl-guest-sidebar');
      center?.removeAttribute('data-dsh-wsl-guest-center');
    };
  }, [model.guest, compact]);
  return <span ref={ref} />;
}

/** Register every conversation-related slot the plugin owns. */
export function installConversationSlots(ctx: ClientContext, model: ClientModel, api: PanelApi): void {
  const panel = model as PanelModel;
  ctx.slots.inject('conversation.input.dock', () => {
    const native = ctx.slots.entries('conversation.session').find((entry) => entry.store?.spec?.persist === 'dsh.conversation');
    if (!native) return;
    return ctx.slots.register(
      { name: 'conversation.input.dock', id: 'dsh-wsl-handoff-draft', store: native.store },
      (props: DraftBindingProps) => <HandoffDraftBinding {...props} ctx={ctx} />,
    );
  });
  ctx.effect(() => installNativeWorkspaces(ctx, panel));
  ctx.effect(() => installNativeSidebar(ctx, panel));
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'dsh-wsl-handoff', order: 350 }, (props: MenuItemProps) => {
      const [, closeMenu] = props.useMenuOpenState();
      if (model.state?.mode !== 'windows-host' || model.guest) return null;
      return (
        <MenuItemButton
          onSelect={() => {
            closeMenu(false);
            const row = panel.conversations.nativeCatalog().rows.find((item) => item.id === props.sessionId);
            if (row) panel.conversations.requestHandoff({ id: row.id, row });
          }}
        >
          {ct('ui.handoff.menu')}
        </MenuItemButton>
      );
    }),
  );
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: CONVERSATION_PANEL }, () => <ConversationTarget ctx={ctx} model={panel} />),
  );
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-wsl-conversations', order: 15 }, () => (
      <>
        <ConversationFrames ctx={ctx} model={panel} />
        <GuestChrome model={panel} />
        <WorkspaceDialogs model={panel} api={api} />
      </>
    )),
  );
  ctx.slots.inject('sidebar.workspaces', () => {
    let dispose: (() => void) | null = null;
    const sync = () => {
      const enabled =
        model.state?.mode === 'windows-host' && !!appOrigin(location.origin) && !!panel.conversations?.unified;
      if (enabled && !dispose) {
        dispose = ctx.slots.register({ name: 'sidebar.workspaces', priority: -80 }, (props: SidebarListProps) => (
          <CompactConversationList {...props} ctx={ctx} model={panel} />
        ));
      } else if (!enabled && dispose) {
        dispose();
        dispose = null;
      }
    };
    const unsubscribe = model.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      dispose?.();
    };
  });
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dsh-wsl-environment', order: 5 }, () => {
      useModel(panel);
      return model.state?.mode === 'wsl-host' && !model.guest ? <WslMark distro={model.state?.settings.distro} /> : null;
    }),
  );
}

/** Props of the mirrored sidebar menu entry. */
interface MenuItemProps {
  sessionId: string;
  useMenuOpenState(): [boolean, (open: boolean) => void];
}

/** Props the sidebar list slot forwards. */
interface SidebarListProps {
  wide?: boolean;
  expandSidebar?: () => void;
}
