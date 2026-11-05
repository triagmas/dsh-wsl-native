import styles from './client.css';
import { TerminalIcon } from './components.js';
import { WslPage } from './page.js';
import { createClientModel } from './client-session.js';
import { createConversations } from './conversation-model.js';
import type { PanelModel } from './panel-types.js';
import { installConversationSlots } from './conversations.js';
import { ct, setClientLocale } from './i18n/client.js';
import type { ClientContext, ClientModel, HarnessResult, PanelApi } from './client-types.js';


export const name = 'dsh-wsl-native-client';
export const inject = ['connection', 'slots', 'layout', 'workspaces', 'uiWorkspace', 'sessions'];

/** Panel context as the DSH client runtime provides it. */
interface PanelContext extends ClientContext {
  connection: ClientContext['connection'];
}

/** Call one control route of the plugin host. */
function createApi(ctx: PanelContext): PanelApi {
  return async (endpoint, payload = {}) => {
    const result: HarnessResult<unknown> = await ctx.connection.rpc.call('/api', `dsh-wsl-native/${endpoint}`, payload);
    if (!result.ok) throw new Error(result.error?.message || ct('client.requestFailed'));
    return result.value;
  };
}

export function apply(ctx: PanelContext): void {
  const api = createApi(ctx);
  // `createConversations` finishes the two-phase init, so the panel model is
  // complete before any component reads it.
  const base: ClientModel = createClientModel(ctx, api);
  const model = base as PanelModel;
  base.conversations = createConversations(ctx, api, base);
  installConversationSlots(ctx, base, api);
  ctx.effect(() => () => model.dispose?.());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.dshWslNative = '';
    style.textContent = styles as unknown as string;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'dsh-wsl-native' }, () => (
      <WslPage api={api} ctx={ctx} model={model} />
    )),
  );
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'dsh-wsl-native',
        order: 20,
        label: () => ct('client.panelTitle'),
      },
      TerminalIcon,
    ),
  );
  // The panel follows the host's persisted language preference on every status refresh.
  void model.refresh().then((state) => {
    if (state?.locale) setClientLocale(state.locale);
  });
}
