import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { useModel } from './page.js';
import { conversationRows } from './conversation-protocol.js';
import { TerminalIcon } from './components.js';
import { ct } from './i18n/client.js';
import type { ClientContext } from './client-types.js';
import type { PanelModel } from './panel-types.js';
import type { ConversationRow } from './conversation-protocol.js';

/** Inline icon paths for the compact list toolbar. */
export const iconPaths = {
  switch: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
  search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1.5L21 21',
  filter: 'M4 6h16M7 12h10M10 18h4',
  plus: 'M12 4v16M4 12h16',
} as const;

type IconName = keyof typeof iconPaths;

function Icon({ name }: { name: IconName }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

type Filter = 'all' | 'windows' | 'wsl';

/** Props forwarded by the `sidebar.workspaces` slot. */
export interface CompactConversationListProps {
  ctx: ClientContext;
  model: PanelModel;
  wide?: boolean;
  expandSidebar?: () => void;
}

/** Unified Windows + WSL conversation list for the Windows sidebar. */
export function CompactConversationList({ ctx, model, wide, expandSidebar }: CompactConversationListProps) {
  useModel(model);
  const chat = model.conversations;
  const local = chat.nativeCatalog();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(35);
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState<ConversationRow | null>(null);
  const [tools, setTools] = useState<'filter' | null>(null);
  const [search, setSearch] = useState(false);
  const section = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!tools) return;
    const close = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !section.current?.contains(target) || (event instanceof KeyboardEvent && event.key === 'Escape')) {
        setTools(null);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [tools]);

  useEffect(() => {
    if (search) searchRef.current?.focus();
  }, [search]);

  if (!wide) {
    return (
      <div className="dsh-wsl-chat-rail">
        <Button variant="ghost" icon={<TerminalIcon size={18} />} aria-label={ct('ui.sidebar.expand')} onClick={expandSidebar} />
      </div>
    );
  }

  const rows = conversationRows(local, [...chat.entries.values()], { filter, query, archived });
  const choose = (action: () => void) => {
    if (window.matchMedia('(max-width:600px)').matches) ctx.layout.toggleSidebar();
    action();
  };
  const run = (row: ConversationRow | null, action: string) => {
    if (!row) return;
    setMenu(null);
    void chat.action(row, action);
  };
  const heading = archived ? ct('ui.sidebar.archived') : filter === 'wsl' ? ct('ui.sidebar.wsl') : filter === 'windows' ? ct('ui.sidebar.windows') : ct('ui.sidebar.all');

  return (
    <section ref={section} className="dsh-wsl-conversations" aria-label={ct('ui.sidebar.listLabel')}>
      <div className="dsh-wsl-compact-heading">
        <span>{heading}</span>
        <button
          type="button"
          className="dsh-wsl-icon-button"
          aria-label={ct('ui.sidebar.switchToNative')}
          title={ct('ui.sidebar.switchToNative')}
          onClick={() => chat.setUnified(false)}
        >
          <Icon name="switch" />
        </button>
        <div className="dsh-wsl-heading-actions">
          <button
            type="button"
            className="dsh-wsl-icon-button"
            aria-label={ct('ui.sidebar.search')}
            title={ct('ui.sidebar.search')}
            aria-expanded={search}
            onClick={() => {
              setSearch(!search);
              if (search) setQuery('');
              setTools(null);
            }}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="dsh-wsl-icon-button"
            aria-label={ct('ui.sidebar.filter')}
            title={ct('ui.sidebar.filterHint')}
            aria-expanded={tools === 'filter'}
            onClick={() => setTools(tools === 'filter' ? null : 'filter')}
          >
            <Icon name="filter" />
          </button>
          <button
            type="button"
            className="dsh-wsl-icon-button dsh-wsl-add-workspace"
            aria-label={ct('ui.sidebar.newWorkspace')}
            title={ct('ui.sidebar.newWorkspace')}
            onClick={() => chat.requestWorkspace()}
          >
            <Icon name="plus" />
            <span aria-hidden="true">WSL</span>
          </button>
        </div>
      </div>
      {tools ? (
        <div className="dsh-wsl-list-popover" role="group" aria-label={ct('ui.sidebar.filterGroup')}>
          <>
            {(
              [
                ['all', ct('ui.sidebar.filterAll')],
                ['windows', 'Windows'],
                ['wsl', 'WSL'],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setLimit(35);
                  setTools(null);
                }}
              >
                {label}
                {filter === value ? ' ✓' : ''}
              </button>
            ))}
            <button
              type="button"
              className="dsh-wsl-menu-divider"
              aria-pressed={archived}
              onClick={() => {
                setArchived(!archived);
                setTools(null);
              }}
            >
              {archived ? ct('ui.sidebar.showCurrent') : ct('ui.sidebar.showArchived')}
            </button>
          </>
        </div>
      ) : null}
      {search ? (
        <Input
          ref={searchRef}
          aria-label={ct('ui.sidebar.searchLabel')}
          placeholder={ct('ui.sidebar.searchPlaceholder')}
          value={query}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setQuery(event.target.value);
            setLimit(35);
          }}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Escape') {
              setQuery('');
              setSearch(false);
            }
          }}
        />
      ) : null}
      {chat.error ? (
        <div className="dsh-wsl-chat-list-error" role="alert">
          {chat.error}
        </div>
      ) : null}
      <div className="dsh-wsl-chat-rows" role="list" aria-label={archived ? ct('ui.sidebar.archivedList') : ct('ui.sidebar.allList')}>
        {rows.slice(0, limit).map((row) => {
          const selected = row.environment
            ? chat.visible() && chat.activeKey === row.environment.key && row.environment.catalog?.selectedId === row.id
            : !ctx.layout.panelInfo.getSnapshot().activePanelId && local.selectedId === row.id;
          const environment = row.environment ? 'WSL' : 'Windows';
          return (
            <div className={`dsh-wsl-chat-row${selected ? ' is-selected' : ''}`} role="listitem" key={row.key}>
              <button
                type="button"
                className="dsh-wsl-chat-row-open"
                aria-current={selected ? 'page' : undefined}
                disabled={archived}
                aria-label={ct('ui.sidebar.rowLabel', { environment, title: row.title })}
                title={`${row.environment ? `WSL · ${row.environment.settings.distro}` : 'Windows'}\n${row.cwd}`}
                onClick={() => choose(() => void chat.openRow(row))}
              >
                <span className="dsh-wsl-chat-dot">{row.running ? <StateDot state="ongoing" /> : row.pinned ? '•' : null}</span>
                <span className="dsh-wsl-chat-row-text">
                  <span>{row.title || ct('ui.sidebar.untitled')}</span>
                </span>
                {row.environment ? (
                  <span className="dsh-wsl-chat-mark" title={`WSL · ${row.environment.settings.distro}`}>
                    WSL
                  </span>
                ) : null}
              </button>
              <button type="button" className="dsh-wsl-chat-more" aria-label={ct('ui.sidebar.manage', { title: row.title })} onClick={() => setMenu(row)}>
                ⋯
              </button>
            </div>
          );
        })}
        {rows.length > limit ? (
          <Button variant="ghost" onClick={() => setLimit(limit + 35)}>
            {ct('ui.sidebar.showMore', { count: rows.length - limit })}
          </Button>
        ) : null}
        {!rows.length ? (
          <div className="dsh-wsl-chat-empty">
            {query
              ? ct('ui.sidebar.noMatches')
              : archived
                ? ct('ui.sidebar.noArchived')
                : ct('ui.sidebar.startHint')}
          </div>
        ) : null}
      </div>
      {chat.busy ? (
        <div className="dsh-wsl-chat-list-foot" role="status">
          <StateDot state="ongoing" />
          {ct('ui.sidebar.preparing')}
        </div>
      ) : null}
      <Modal open={!!menu} onClose={() => setMenu(null)} closeLabel={ct('ui.common.close')} title={menu?.title || ct('ui.sidebar.manageTitle')}>
        {menu ? (
          <div className="dsh-wsl-chat-menu">
            <p>
              {menu.environment ? `WSL · ${menu.environment.settings.distro}` : 'Windows'} · {menu.cwd}
            </p>
            {!menu.archived ? (
              <Button onClick={() => run(menu, menu.pinned ? 'unpin' : 'pin')}>
                {menu.pinned ? ct('ui.sidebar.unpin') : ct('ui.sidebar.pin')}
              </Button>
            ) : null}
            <Button onClick={() => run(menu, menu.archived ? 'unarchive' : 'archive')}>
              {menu.archived ? ct('ui.sidebar.restore') : ct('ui.sidebar.archive')}
            </Button>
            {!menu.archived ? (
              <Button
                onClick={() => {
                  chat.requestHandoff({ id: menu.id, row: menu, entry: menu.environment ?? undefined });
                  setMenu(null);
                }}
              >
                {ct('ui.handoff.menu')}
              </Button>
            ) : null}
            {menu.environment ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const entry = chat.entries.get(menu.environment?.key ?? '');
                  if (entry) chat.closeView(entry);
                  setMenu(null);
                }}
              >
                {ct('ui.sidebar.closeView')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
