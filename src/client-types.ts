/**
 * Structural types for the DSH browser runtime.
 *
 * The Harness does not export a single public plugin-context type, so the panel
 * declares exactly the members it uses. Every member here is verified against
 * the installed `@deepseek-ai/dsh-client-*` type declarations; anything the code
 * touches dynamically (guest messages, catalogs, persisted state) is validated
 * by the runtime guards in `conversation-protocol.ts` before it is trusted.
 */

import type { ConversationModel } from './conversation-model.js';
import type { GuestState } from './conversation-guest.js';

/** One reactive store slice: snapshot plus change subscription. */
export interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** Harness result wrapper used by controller calls. */
export type HarnessResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } };

/** One session row as the sidebar renders it. */
export interface SessionRow {
  id: string;
  title?: string;
  displayTitle?: string;
  cwd?: string;
  blank?: boolean;
  running?: boolean;
  updatedAt: number;
  parentId?: string;
  retainedBy?: { mainView?: number };
}

/** Session list snapshot. */
export interface SessionList {
  phase: string;
  ids: string[];
  byId: Record<string, SessionRow | undefined>;
}

/** One workspace row as the sidebar renders it. */
export interface WorkspaceRow {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt?: string;
}

/** Workspace list snapshot. */
export interface WorkspaceList {
  phase: string;
  items: WorkspaceRow[];
  pinnedSessionIds: string[];
  archivedSessionIds: string[];
}

/** One search hit from the session controller. */
export interface SearchHit {
  sessionId: string;
  snippet: string;
}

/** Session controller surface used by the panel. */
export interface SessionsService {
  list: Store<SessionList>;
  refresh(): Promise<unknown>;
  create(input: { workspaceId: string }): Promise<string>;
  search(query: string): Promise<HarnessResult<{ items: SearchHit[]; hasMore: boolean }>>;
  using<T>(
    sessionId: string,
    options: { source: string },
    callback: (reference: {
      binding: {
        /** Session binding handed back to the caller for direct operations. */
        ctx: unknown;
        session: {
          rename(name: string): Promise<HarnessResult<unknown>>;
          prompt(parts: { type: 'text'; text: string }[], mode: 'queue' | 'send'): Promise<HarnessResult<unknown>>;
        };
      };
      eventSource: { getSnapshot(): { entries: unknown[] } };
    }) => Promise<HarnessResult<T>>,
  ): Promise<HarnessResult<T>>;
}

/** Workspace controller surface used by the panel. */
export interface WorkspacesService {
  list: Store<WorkspaceList>;
  create(input: { path: string }): Promise<WorkspaceRow>;
  rename(workspaceId: string, title: string): Promise<unknown>;
  delete(workspaceId: string): Promise<unknown>;
  insertBefore(workspaceId: string, beforeId?: string): Promise<unknown>;
}

/** Navigation controller for the workspace pane. */
export interface UiWorkspaceService {
  connectWorkspace(workspaceId: string): Promise<string>;
  openSession(sessionId: string): void;
  startSession(): void;
  forkSession(sessionId: string): Promise<string>;
  pinSession(sessionId: string): Promise<unknown>;
  unpinSession(sessionId: string): Promise<unknown>;
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<unknown>;
  unarchiveSession(sessionId: string): Promise<unknown>;
}

/** Which panel is currently visible on the right. */
export interface PanelInfo {
  activePanelId: string | null;
}

/** Layout controller surface used by the panel. */
export interface LayoutService {
  panelInfo: Store<PanelInfo>;
  selectPanel(panel: string | null): void;
  toggleSidebar(): void;
  beginNavigation(): { readonly aborted: boolean };
}

/** Connection lifecycle events the panel listens to. */
export interface ConnectionService {
  state: Store<string>;
  rpc: {
    call(namespace: string, method: string, payload?: Record<string, unknown>): Promise<HarnessResult<unknown>>;
  };
}

/** Slot registry used for the main panel and the sidebar entry. */
export interface SlotDefinition {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  priority?: number;
  label?: () => string;
  store?: unknown;
  locale?: string;
  inject?: unknown;
  children?: Record<string, SlotDefinition>;
}

/** One slot registration as the mirroring code reads it back. */
export interface SlotEntry {
  name?: string;
  component: unknown;
  options?: Record<string, unknown>;
  inject?: unknown;
  store?: { spec?: { persist?: string } } | null;
  locale?: string;
  children?: Record<string, SlotEntry>;
}

export interface SlotsService {
  register(definition: SlotDefinition, component: unknown): () => void;
  entries(name: string): SlotEntry[];
  inject(name: string, callback: () => (() => void) | void): void;
  subscribe(name: string, listener: () => void): () => void;
}

/** One physical key combination declared for a shortcut command. */
export interface ShortcutBinding {
  code: string;
  modifiers: string[];
  secondCode?: string;
}

/**
 * A command in the host shortcut catalog. `defaults` may be empty: the command
 * then exists with no binding and the user can assign one, which is the only
 * supported way to reach a shipped chord.
 */
export interface ShortcutCommand {
  id: string;
  label: () => string;
  aliases?: string[];
  defaults?: Record<string, ShortcutBinding | null>;
  regions?: string[];
  modals?: string[];
  resolve: () => { status: 'handled'; run: () => void } | { status: 'ignored' };
}

/** Shortcut catalog service, injected as `shortcuts` by the host. */
export interface ShortcutsService {
  register(command: ShortcutCommand): () => void;
}

/** The plugin context available to the browser module. */
export interface ClientContext {
  connection: ConnectionService;
  sessions: SessionsService;
  workspaces: WorkspacesService;
  uiWorkspace: UiWorkspaceService;
  layout: LayoutService;
  slots: SlotsService;
  shortcuts?: ShortcutsService;
  effect(setup: () => () => void): void;
  on(event: string, listener: () => void): () => void;
  get(name: string): unknown;
  inject(dependencies: string[], callback: (ctx: ClientContext) => void): void;
}

/** One directory entry returned by the host bridge. */
export interface DirectoryEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
}

/** One page of a directory listing. */
export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  nextOffset?: number | null;
}

/** One bridge connection as reported by the host. */
export interface PoolConnection {
  target: [string, ...unknown[]];
  connected: boolean;
  info?: { user?: string; home?: string; node?: string } | null;
}

/** A launch request waiting for the Linux host to become ready. */
export interface PendingHandoff {
  id: string;
  mode: 'new' | 'same';
}

/** A sub-model that cleans up after itself. */
export interface DisposableModel {
  dispose?(): void;
}

/**
 * Panel model shared by every client module: host status, persisted choices and
 * the sub-models attached at runtime (conversations, embedded guest).
 */
export interface ClientModel {
  state: PanelStatus | null;
  error: string | null;
  draft: { distro: string; user: string; directory: string } | null;
  pending: PendingHandoff | null;
  popup: Window | null;
  parentOrigin: string | null;
  readyLink: string | null;
  guest?: GuestState | null;
  conversations?: ConversationModel;
  subscribe(listener: () => void): () => void;
  emit(): void;
  refresh(): Promise<PanelStatus>;
  setPending(pending: PendingHandoff | null): void;
  remember(): void;
  adopt(): Promise<void>;
  dispose?(): void;
}

/** Panel API call bound to the plugin's control routes. */
export type PanelApi = (endpoint: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Identity of the Linux environment a conversation belongs to. */
export interface EnvironmentSettings {
  distro: string;
  user: string;
  directory: string;
}

/** Progress reported by the host launcher. */
export interface NativeProgress {
  phase: string;
  text: string;
}

/** A signed handoff returned by the host. */
export interface HandoffRecord {
  id: string;
  distro: string;
  user: string;
  directory: string;
  parentOrigin: string | null;
  state: 'preparing' | 'starting' | 'ready' | 'failed';
  url?: string;
  openUrl?: string;
  error?: string;
  startedAt: number;
  readyAt?: number;
}

/** One inherited plugin entry in the last report. */
export interface InheritedPlugin {
  name: string;
  version: string;
  status: 'inherited' | 'overridden' | 'unsupported';
  reason?: string;
}

/** Last inheritance report. */
export interface InheritanceReport {
  date: string;
  source: string | null;
  plugins: InheritedPlugin[];
  overrides: number;
  settings: boolean;
  credentials: boolean;
}

/** Inheritance feature state. */
export interface InheritanceState {
  available: boolean;
  source: string | null;
  options: { plugins: boolean; config: boolean; credentials: boolean };
  applied: InheritanceReport | null;
}

/** Standing permission grant. */
export interface GrantView {
  id: string;
  capability: string;
  target: string;
  root: string | null;
  createdAt: number;
  expiresAt: number | null;
}

/** The three permission modes the plugin supports. */
export type PermissionMode = 'protected' | 'trusted' | 'full-access';

/** Permission state shown by the panel. */
export interface PermissionView {
  mode: PermissionMode;
  modeIssuedAt: number | null;
  modeExpiresAt: number | null;
  grants: GrantView[];
}

/** Running instance of the Linux DSH. */
export interface NativeRunning {
  id: string;
  url: string;
  openUrl?: string;
  distro: string;
  dshHome: string;
  startedAt: number;
}

/** One environment instance tracked by the host. */
export interface NativeInstance {
  settings: EnvironmentSettings;
  running: NativeRunning | null;
  progress: NativeProgress;
  preparing: boolean;
  starting: boolean;
}

/** `/api/dsh-wsl-native/status` response. */
export interface PanelStatus {
  version: string;
  host: string;
  mode: 'windows-host' | 'wsl-host' | 'unsupported';
  node: string;
  locale: string;
  locales: readonly string[];
  settings: EnvironmentSettings;
  preferences: { autoStartWsl: boolean; locale: string };
  profiles: (EnvironmentSettings & { recentDirectories: string[]; storage?: string })[];
  distros: { name: string; state: string; version: number; isDefault: boolean }[];
  permissions: PermissionView;
  pool: { connections: PoolConnection[] };
  error: string | null;
  parentOrigin: string | null;
  launchDirectory: string | null;
  handoffs: HandoffRecord[];
  native: {
    inheritance: InheritanceState;
    running: NativeRunning | null;
    progress: NativeProgress;
    preparing: boolean;
    starting: boolean;
    instances: NativeInstance[];
  };
}

/** Catalog row shared between the Windows sidebar and a Linux guest. */
export interface CatalogRow {
  id: string;
  title: string;
  cwd: string;
  workspaceId: string;
  workspaceTitle: string;
  running: boolean;
  blank: boolean;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
}

/** Catalog workspace. */
export interface CatalogWorkspace {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** Navigation catalog published by a Linux guest. */
export interface Catalog {
  rows: CatalogRow[];
  workspaces: CatalogWorkspace[];
  selectedId: string | null;
  connected: boolean;
  phase: 'ready' | 'loading';
}

/** Result of a guest request forwarded to the host panel. */
export interface GuestResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Message exchanged between the panel and an embedded guest. */
export interface GuestMessage {
  protocol?: string;
  channel?: string;
  type?: string;
  id?: string;
  action?: string;
  payload?: Record<string, unknown>;
  ok?: boolean;
  value?: unknown;
  error?: string;
  catalog?: unknown;
}

/** Browser event with the fields the protocol checks. */
export interface GuestEvent {
  origin: string;
  source: unknown;
  data?: GuestMessage;
}
