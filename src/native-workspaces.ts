import { conversationRows, type ConversationRow } from './conversation-protocol.js';
import { ct } from './i18n/client.js';
import type { Catalog, ClientContext, PanelStatus } from './client-types.js';

/** One row source the sidebar renders. */
export interface EnvironmentLike {
  key: string;
  settings: { distro: string; user: string; directory: string };
  catalog?: Catalog | null;
}

/** A workspace group in the unified sidebar. */
export interface WorkspaceGroup {
  key: string;
  environment: NonNullable<ConversationRow['environment']>;
  path: string;
  title: string;
  rows: ConversationRow[];
}

/** Group remote conversations by workspace for the Windows sidebar. */
export function remoteWorkspaceGroups(environments: EnvironmentLike[], query = ''): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const row of conversationRows(null, environments, { filter: 'wsl', query })) {
    const environment = row.environment;
    if (!environment) continue;
    const key = JSON.stringify([environment.key, row.workspaceId || row.cwd]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        environment,
        path: row.cwd,
        title: row.workspaceTitle || row.cwd.split('/').filter(Boolean).at(-1) || 'Linux',
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.rows.some((row) => row.running)) - Number(a.rows.some((row) => row.running)) ||
      a.title.localeCompare(b.title),
  );
}

/** Panel model members used by the sidebar augmentation. */
export interface SidebarModel {
  state: PanelStatus | null;
  subscribe(listener: () => void): () => void;
  conversations: {
    setUnified(value: boolean): void;
    requestWorkspace(): void;
    createWindows(workspaceId?: string): Promise<void>;
    createLinux(): Promise<void>;
    newLinux(entry?: { settings: { distro: string }; ready?: boolean }): Promise<void>;
    entries: ReadonlyMap<string, { settings: { distro: string }; ready?: boolean }>;
    activeKey: string | null;
    busy: boolean;
    unified: boolean;
  };
}

/** Attributes owned by this module, removed on disposal. */
const OWNED = 'data-dsh-wsl-owned';
const OWNED_ATTR = 'dataDshWslOwned';

/**
 * Only header affordances and badges need DOM augmentation: the tree itself is
 * rendered by DSH. Every owned node and attribute is removed on disposal.
 */
export function installNativeWorkspaces(ctx: ClientContext, model: SidebarModel): () => void {
  const doc = document;
  let observer: MutationObserver | undefined;
  let sidebar: Element | null = null;
  let scheduled: number | undefined;
  let disposed = false;
  let originalButton: HTMLElement | null = null;

  const button = (label: string, cls: string, icon: string, action: () => void): HTMLButtonElement => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = cls;
    node.title = label;
    node.setAttribute('aria-label', label);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      width: '16',
      height: '16',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    })) {
      svg.setAttribute(key, value);
    }
    const path = doc.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', icon);
    svg.append(path);
    node.append(svg);
    node.addEventListener('click', action);
    return node;
  };

  const toggle = button(ct('client.sidebarToggle'), 'dsh-wsl-icon-button dsh-wsl-native-toggle', 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4', () =>
    model.conversations.setUnified(true),
  );
  const add = button(ct('client.addWorkspace'), 'dsh-wsl-icon-button dsh-wsl-add-workspace', 'M3 7V5h6l2 2h10v13H3V7m9 4v6m-3-3h6', () =>
    model.conversations.requestWorkspace(),
  );
  const addMark = doc.createElement('span');
  addMark.textContent = 'WSL';
  addMark.setAttribute('aria-hidden', 'true');
  add.append(addMark);
  add.dataset[OWNED_ATTR] = '';
  const pair = doc.createElement('div');
  pair.className = 'dsh-wsl-new-bar';
  pair.dataset[OWNED_ATTR] = '';
  // One primary action: the default New Chat is always the WSL runtime.
  const linux = button(ct('client.newWslChat'), 'dsh-wsl-new-primary', 'M3 5h18v14H3zM7 9l3 3-3 3m6 0h4', () => {
    void model.conversations.createLinux();
  });
  linux.title = ct('client.newWslChatHint');
  // The Windows runtime keeps its own control; it is never the default and the
  // primary action cannot reach it.
  const win = button(ct('client.newWindowsExplicit'), 'dsh-wsl-new-secondary', 'M3 4h18v13H3zM8 21h8m-4-4v4', () => {
    void model.conversations.createWindows();
  });
  win.title = ct('client.newWindowsExplicitHint');
  const label = doc.createElement('span');
  label.textContent = ct('client.newWslChat');
  linux.append(label);
  pair.append(linux, win);
  const marks = new Set<HTMLElement>();

  function sync(): void {
    scheduled = undefined;
    if (disposed) return;
    if (model.state?.mode !== 'windows-host') return;
    const frame = doc.querySelector('[data-shell-overlay]')?.parentElement;
    const right = frame?.querySelector(':scope > [data-rightbar-col]');
    const nextSidebar = right?.previousElementSibling?.previousElementSibling ?? null;
    if (!nextSidebar) return;
    if (sidebar !== nextSidebar) {
      observer?.disconnect();
      sidebar = nextSidebar;
      observer = new MutationObserver((records) => {
        if (records.some((record) => !isOwned(record.target) && [...record.addedNodes, ...record.removedNodes].some((node) => !isOwned(node)))) {
          schedule();
        }
      });
      observer.observe(sidebar, { subtree: true, childList: true });
    }
    const nativeButton = sidebar.querySelector<HTMLElement>('button[class*="newSession"]');
    if (nativeButton) {
      if (originalButton !== nativeButton) {
        originalButton?.removeAttribute('data-dsh-wsl-replaced');
        originalButton = nativeButton;
      }
      nativeButton.setAttribute('data-dsh-wsl-replaced', '');
      if (pair.previousElementSibling !== nativeButton) nativeButton.after(pair);
      const header2 = nativeButton.parentElement;
      pair.classList.toggle('is-narrow', (header2?.getBoundingClientRect().width ?? 999) < 200);
      win.hidden = (header2?.getBoundingClientRect().width ?? 999) < 160;
    }
    linux.setAttribute('aria-busy', String(model.conversations.busy));
    const header = sidebar.querySelector<HTMLElement>('[class*="sectionHeader"]');
    if (header && !model.conversations.unified) {
      const label = header.querySelector(':scope > span');
      if (toggle.parentElement !== header) {
        if (label) label.after(toggle);
        else header.prepend(toggle);
      }
      if (add.parentElement !== header) header.append(add);
    } else {
      toggle.remove();
      add.remove();
    }
    for (const mark of marks) if (!mark.isConnected) marks.delete(mark);
    for (const [kind, titleClass] of [
      ['workspace', 'projectText'],
      ['session', 'title'],
    ] as const) {
      for (const row of sidebar.querySelectorAll<HTMLElement>(`[data-row-key^="${kind}:dsh-wsl:"]`)) {
        if (row.querySelector(':scope > .dsh-wsl-workspace-mark')) continue;
        const title = row.querySelector<HTMLElement>(`:scope > [class*="${titleClass}"]`);
        if (!title) continue;
        const mark = doc.createElement('span');
        mark.dataset[OWNED_ATTR] = '';
        mark.className = 'dsh-wsl-workspace-mark' + (kind === 'session' ? ' dsh-wsl-session-mark' : '');
        mark.textContent = 'WSL';
        mark.title = kind === 'session' ? ct('client.wslSession') : ct('client.wslWorkspace');
        title.after(mark);
        marks.add(mark);
      }
    }
  }

  function isOwned(node: Node): boolean {
    return node instanceof HTMLElement && (node.hasAttribute(OWNED) || OWNED_ATTR in node.dataset);
  }

  function schedule(): void {
    if (!disposed && scheduled === undefined) scheduled = requestAnimationFrame(sync);
  }

  const off = model.subscribe(schedule);
  const offSlots = ctx.slots.subscribe('sidebar.workspaces', schedule);
  schedule();
  return () => {
    disposed = true;
    if (scheduled !== undefined) cancelAnimationFrame(scheduled);
    observer?.disconnect();
    off();
    offSlots();
    originalButton?.removeAttribute('data-dsh-wsl-replaced');
    pair.remove();
    toggle.remove();
    add.remove();
    for (const mark of marks) mark.remove();
  };
}
