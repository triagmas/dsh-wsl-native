import styles from './client.css';
import { TerminalIcon } from './components.jsx';
import { WslPage } from './page.jsx';
import { createClientModel } from './client-session.js';
import { createConversations } from './conversation-model.js';
import { installConversationSlots } from './conversations.jsx';
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
  const model: ClientModel = createClientModel(ctx, api);
  model.conversations = createConversations(ctx, api, model);
  installConversationSlots(ctx, model, api);
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
