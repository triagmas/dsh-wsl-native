import { ct } from './i18n/client.js';

/** Stable command id for the host shortcut catalog. */
export const NEW_WSL_CHAT_SHORTCUT_ID = 'dsh-wsl-native.session.new';

/** Search aliases so the command is findable next to the shipped ones. */
export const NEW_WSL_CHAT_ALIASES = ['new wsl chat', 'new chat in wsl', 'wsl chat'];

/** Minimal environment entry the routing decision needs. */
export interface NewChatEntry {
  settings: { distro: string };
  ready?: boolean;
}

/** Inputs the routing decision reads; nothing here creates a session. */
export interface NewChatInput<E extends NewChatEntry = NewChatEntry> {
  settings: { distro?: string } | null | undefined;
  entries: ReadonlyMap<string, E>;
  activeKey: string | null;
}

/**
 * Where a normal New Chat must go.
 *
 * There is deliberately no `windows` member: a Windows session is reachable only
 * through the explicit control, never as the result of the default action. A
 * missing distribution is an error the caller must show, not a fallback.
 */
export type NewChatPlan<E extends NewChatEntry = NewChatEntry> =
  | { kind: 'wsl'; distro: string; entry: E | undefined }
  | { kind: 'error'; reason: 'wsl-not-configured'; message: string };

/** Resolve the default New Chat target from the persisted selection. */
export function planNewChat<E extends NewChatEntry>(input: NewChatInput<E>): NewChatPlan<E> {
  const active = input.activeKey === null ? undefined : input.entries.get(input.activeKey);
  const activeDistro = active?.settings.distro.trim();
  if (activeDistro) return { kind: 'wsl', distro: activeDistro, entry: active };
  const storedDistro = input.settings?.distro?.trim();
  if (storedDistro) return { kind: 'wsl', distro: storedDistro, entry: undefined };
  return { kind: 'error', reason: 'wsl-not-configured', message: ct('client.wslNotConfigured') };
}
