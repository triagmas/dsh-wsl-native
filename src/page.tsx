import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  StateDot,
  Switch,
  IconChevronDownOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  TerminalIcon,
  SystemIcon,
  OpenIcon,
  Badge,
  DirectoryPicker,
  normalized,
  directoryError,
} from './components.js';
import { appOrigin, parentUrl } from './handoff.js';
import { openProject } from './client-session.js';
import { InheritanceSection } from './inheritance-ui.js';
import { PermissionsSection } from './permissions-ui.js';
import { ct } from './i18n/client.js';
import type { PanelStatus } from './client-types.js';
import type { EnvironmentDraft, Notice, PanelModel, PanelProps } from './panel-types.js';

/** Subscribe a component to the shared panel model and return its status. */
export function useModel(model: PanelModel): PanelStatus | null {
  const [, update] = useState(0);
  useEffect(() => model.subscribe(() => update((value) => value + 1)), [model]);
  return model.state;
}

/** A destructive action the panel asks the user to confirm. */
type ConfirmDialog =
  | { kind: 'stop'; settings: { distro: string; user: string; directory: string } }
  | { kind: 'disconnect' }
  | null;

/** Main plugin panel: environment, connection and diagnostics. */
export function WslPage({ api, ctx, model }: PanelProps) {
  const state = useModel(model);
  const [draft, setDraft] = useState<EnvironmentDraft | null>(model.draft);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [picker, setPicker] = useState(false);
  const [dialog, setDialog] = useState<ConfirmDialog>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(() => model.refresh(), [model]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (state && !draft) setDraft(normalized(state.settings, state.distros));
  }, [state, draft]);

  useEffect(() => {
    model.draft = draft;
  }, [draft, model]);

  // Work survives page reloads. Navigation happens only for the request this tab made.
  useEffect(() => {
    const pending = model.pending;
    if (!pending) return;
    const handoff = state?.handoffs?.find((item) => item.id === pending.id);
    if (handoff?.state === 'ready') {
      model.remember();
      model.readyLink = handoff.url ?? null;
      model.setPending(null);
      if (pending.mode === 'same') {
        void model.conversations.adopt(handoff as never).catch((error: Error) => {
          model.error = error.message;
          model.emit();
        });
      } else if (model.popup && !model.popup.closed) {
        model.popup.location.replace(handoff.url ?? '');
        model.popup = null;
        setNotice({ text: ct('ui.page.openedInNewWindow') });
      } else {
        setNotice({ text: ct('ui.page.readyInNewWindow') });
      }
    } else if (handoff?.state === 'failed') {
      model.popup?.close();
      model.popup = null;
      model.setPending(null);
      setNotice({ error: true, text: handoff.error ?? ct('ui.page.launchFailed') });
    } else if (state && !handoff) {
      model.setPending(null);
      setNotice({ error: true, text: ct('ui.page.launcherReconnected') });
    }
  }, [state, model, model.pending]);

  useEffect(() => {
    const preparing = state?.native?.instances?.some((item) => item.preparing || item.starting);
    if (!model.pending && !preparing) return;
    const timer = setTimeout(() => {
      void refresh().catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [state, model, model.pending, refresh]);

  async function task(kind: string, action: () => Promise<unknown>): Promise<void> {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    setNotice(null);
    model.error = null;
    try {
      await action();
    } catch (error) {
      if (mounted.current) setNotice({ error: true, text: directoryError(error as Error) });
    } finally {
      try {
        await refresh();
      } catch {
        /* The shared model exposes the connection error. */
      }
      working.current = false;
      if (mounted.current) setBusy('');
    }
  }

  function edit(key: keyof EnvironmentDraft, value: string): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setNotice(null);
  }

  const chosen = (): EnvironmentDraft => ({
    distro: draft?.distro ?? '',
    user: (draft?.user ?? '').trim(),
    directory: (draft?.directory ?? '').trim(),
  });

  async function selectEnvironment(
    next: EnvironmentDraft,
    message: string = ct('ui.page.environmentConnected'),
  ): Promise<{ settings: never }> {
    const result = (await api('environment/switch', next)) as { settings: never };
    if (mounted.current) {
      setDraft(normalized(result.settings as never, state?.distros ?? []));
      setNotice({ text: message });
    }
    return result;
  }

  function enter(newWindow = false): void {
    if (working.current || model.pending) return;
    // Reserve the window in the click event so browser popup rules do not block a cold start.
    if (newWindow) {
      model.popup = window.open('about:blank', '_blank');
      if (model.popup) {
        model.popup.opener = null;
        model.popup.document.title = ct('ui.page.preparingWindowTitle');
        model.popup.document.body.textContent = ct('ui.page.preparingWindowBody');
        model.popup.document.body.style.cssText =
          'font:14px/1.7 system-ui;padding:48px;max-width:560px;margin:auto;color:#666;background:#fafafa';
      }
    }
    void task('enter', async () => {
      try {
        model.remember();
        const result = (await api('native/enter', {
          ...chosen(),
          parentOrigin: appOrigin(window.location.origin),
        })) as { id: string; settings: never };
        setDraft(normalized(result.settings, state?.distros ?? []));
        // Refresh before installing the pending id, avoiding stale-status cancellation.
        await refresh();
        model.setPending({ id: result.id, mode: newWindow ? 'new' : 'same' });
      } catch (error) {
        model.popup?.close();
        model.popup = null;
        throw error;
      }
    });
  }

  if (!state || !draft) {
    return (
      <div className="dsh-wsl-page">
        <header className="dsh-wsl-heading">
          <div>
            <h1>{ct('ui.page.title')}</h1>
            <p>{ct('ui.page.subtitle')}</p>
          </div>
        </header>
        <div className="dsh-wsl-empty" role={model.error ? 'alert' : 'status'}>
          {model.error ?? (
            <>
              <StateDot state="ongoing" />
              {ct('ui.page.loadingEnvironment')}
            </>
          )}
          {model.error ? (
            <Button onClick={() => task('refresh', async () => {})}>{ct('ui.common.reconnect')}</Button>
          ) : null}
        </div>
      </div>
    );
  }

  const wslHost = state.mode === 'wsl-host';
  const supported = state.mode !== 'unsupported';
  const saved = normalized(state.settings, state.distros);
  const dirty = (['distro', 'user', 'directory'] as const).some((key) => draft[key].trim() !== saved[key]);
  const native = state.native;
  const running = native.running;
  const pending = model.pending && state.handoffs?.find((item) => item.id === model.pending?.id);
  const activeWork = !!(native.preparing || native.starting || model.pending);
  const disabled = !!busy || !!model.pending || !supported;
  const profile = state.profiles?.find(
    (item) => item.distro === draft.distro && item.user === draft.user.trim(),
  );
  const linuxConnection = state.pool.connections.find(
    (connection) =>
      connection.connected &&
      connection.target[0] === 'wsl' &&
      connection.target[1] === draft.distro &&
      (connection.target[2] === draft.user.trim() || connection.info?.user === draft.user.trim()),
  );
  const windowsConnected = state.pool.connections.some(
    (connection) => connection.connected && connection.target[0] === 'windows',
  );
  const errorText =
    (notice?.error ? notice.text : '') ||
    model.error ||
    state.error ||
    (!supported ? ct('ui.page.unsupported') : '');
  const statusText = errorText || notice?.text;
  const link = running?.openUrl ?? null;
  const parentLink = model.parentOrigin ? parentUrl(model.parentOrigin) : null;
  const progress =
    pending?.state === 'starting' || native.starting
      ? ct('ui.page.progress.starting')
      : (native.progress?.text ?? ct('ui.page.progress.connecting'));

  return (
    <div className="dsh-wsl-page">
      <header className="dsh-wsl-heading">
        <div>
          <h1>{ct('ui.page.title')}</h1>
          <p>{ct('ui.page.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          icon={<IconRefreshOutlineRegular />}
          title={ct('ui.page.refresh')}
          aria-label={ct('ui.page.refresh')}
          disabled={!!busy}
          onClick={() => task('refresh', async () => {})}
        />
      </header>

      {!wslHost ? (
        <div className="dsh-wsl-unified-setting">
          <span>{ct('ui.page.unifiedHint')}</span>
          <Button
            variant="ghost"
            onClick={() => model.conversations.setUnified(!model.conversations.unified)}
          >
            {model.conversations.unified ? ct('ui.page.useNativeList') : ct('ui.page.useCompactList')}
          </Button>
        </div>
      ) : null}

      {!wslHost ? (
        <div className="dsh-wsl-startup-setting">
          <div>
            <strong>{ct('ui.page.autoStart.title')}</strong>
            <small>{ct('ui.page.autoStart.description')}</small>
          </div>
          <Switch
            label={ct('ui.page.autoStart.title')}
            checked={state.preferences?.autoStartWsl === true}
            disabled={disabled}
            onChange={(checked: boolean) =>
              void task('preferences', () => api('preferences', { autoStartWsl: checked }))
            }
          />
        </div>
      ) : null}

      {statusText ? (
        <div className={`dsh-wsl-notice ${errorText ? 'is-error' : ''}`} role={errorText ? 'alert' : 'status'}>
          <StateDot state={errorText ? 'error' : 'done'} />
          <span>{statusText}</span>
        </div>
      ) : null}

      <section className="dsh-wsl-section" aria-labelledby="dsh-wsl-host-title">
        <div className="dsh-wsl-section-heading">
          <h2 id="dsh-wsl-host-title">{ct('ui.page.environments.title')}</h2>
          <span className="dsh-wsl-caption">{ct('ui.page.environments.caption')}</span>
        </div>
        <div className="dsh-wsl-host-grid">
          <article className={`dsh-wsl-card dsh-wsl-host-card ${!wslHost ? 'is-current' : ''}`}>
            <div className="dsh-wsl-host-head">
              <SystemIcon size={23} />
              <Badge state={!wslHost ? 'done' : 'idle'}>
                {!wslHost ? ct('ui.common.currentEnvironment') : ct('ui.page.environments.independent')}
              </Badge>
            </div>
            <h3>{ct('ui.page.windows.title')}</h3>
            <p>
              {ct('ui.page.windows.line1')}
              <br />
              {ct('ui.page.windows.line2')}
            </p>
            <div className="dsh-wsl-host-actions">
              {!wslHost ? (
                <Button variant="outline" onClick={() => ctx.layout.selectPanel(null)}>
                  {ct('ui.page.windows.continue')}
                </Button>
              ) : parentLink ? (
                <>
                  <Button
                    variant="outline"
                    icon={<SystemIcon size={16} />}
                    onClick={() => {
                      model.remember();
                      if (model.guest) model.guest.returnWindows();
                      else window.location.assign(parentLink);
                    }}
                  >
                    {ct('ui.page.switchToWindows')}
                  </Button>
                  <a
                    className="dsh-wsl-text-link"
                    href={parentLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {ct('ui.common.openInNewWindow')}
                    <OpenIcon />
                  </a>
                </>
              ) : (
                <span className="dsh-wsl-caption">{ct('ui.page.returnHint')}</span>
              )}
            </div>
          </article>
          <article className={`dsh-wsl-card dsh-wsl-host-card ${wslHost ? 'is-current' : ''}`}>
            <div className="dsh-wsl-host-head">
              <TerminalIcon size={23} />
              <Badge state={wslHost || running ? 'done' : activeWork ? 'ongoing' : 'idle'}>
                {wslHost
                  ? ct('ui.common.currentEnvironment')
                  : running
                    ? ct('ui.page.linux.ready')
                    : activeWork
                      ? ct('ui.page.linux.preparing')
                      : ct('ui.page.linux.onDemand')}
              </Badge>
            </div>
            <h3>
              {ct('ui.page.linux.title')} <span>{draft.distro || 'WSL'}</span>
            </h3>
            <p>
              {ct('ui.page.linux.line1')}
              <br />
              {ct('ui.page.linux.line2')}
            </p>
            <div className="dsh-wsl-host-actions">
              {wslHost ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    task('workspace', async () => {
                      const result = await selectEnvironment(chosen());
                      await openProject(ctx, (result.settings as { directory: string }).directory);
                    })
                  }
                >
                  {ct('ui.page.linux.continue')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="primary"
                    icon={activeWork ? <StateDot state="ongoing" /> : <TerminalIcon size={16} />}
                    disabled={disabled || !draft.distro || activeWork}
                    onClick={() => enter(false)}
                  >
                    {activeWork
                      ? ct('ui.page.linux.preparingShort')
                      : running
                        ? ct('ui.page.linux.openConversation')
                        : ct('ui.page.linux.start')}
                  </Button>
                  {link && !dirty ? (
                    <a className="dsh-wsl-text-link" href={link} target="_blank" rel="noopener noreferrer">
                      {ct('ui.common.openInNewWindow')}
                      <OpenIcon />
                    </a>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={disabled || !draft.distro || activeWork}
                      icon={<OpenIcon />}
                      onClick={() => enter(true)}
                    >
                      {ct('ui.page.linux.openBoth')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </article>
        </div>
        {activeWork ? (
          <div className="dsh-wsl-native-status" role="status">
            <StateDot state="ongoing" />
            <span>{progress}</span>
          </div>
        ) : null}
        {!wslHost && !activeWork ? (
          <p className="dsh-wsl-section-note">{ct('ui.page.environments.note')}</p>
        ) : null}
      </section>

      <InheritanceSection state={state} model={model} chosen={chosen} task={task} api={api} disabled={disabled || activeWork} />
      <PermissionsSection model={model} api={api} disabled={disabled || activeWork} />

      <section className="dsh-wsl-section" aria-labelledby="dsh-wsl-connection-title">
        <div className="dsh-wsl-section-heading">
          <h2 id="dsh-wsl-connection-title">{ct('ui.page.directory.title')}</h2>
          <Badge state={linuxConnection ? 'done' : 'idle'}>
            {linuxConnection ? ct('ui.page.directory.connected') : ct('ui.page.directory.onDemand')}
          </Badge>
        </div>
        <div className="dsh-wsl-card">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled) void task('connect', () => selectEnvironment(chosen()));
            }}
          >
            <div className="dsh-wsl-fields">
              <div className="dsh-wsl-field">
                <label htmlFor="dsh-wsl-distro">{ct('ui.page.directory.distro')}</label>
                <div className="dsh-wsl-select-wrap">
                  <select
                    id="dsh-wsl-distro"
                    value={draft.distro}
                    disabled={disabled || wslHost}
                    onChange={(event) => {
                      const distro = event.target.value;
                      const recent = state.profiles?.find((item) => item.distro === distro);
                      void task('switch', async () => {
                        await selectEnvironment(
                          { distro, user: recent?.user ?? '', directory: recent?.directory ?? '' },
                          ct('ui.page.directory.switched'),
                        );
                      });
                    }}
                  >
                    {!state.distros.length ? (
                      <option value="">{ct('ui.page.directory.noDistro')}</option>
                    ) : null}
                    {state.distros.map((distro) => (
                      <option key={distro.name} value={distro.name}>
                        {distro.name}
                        {distro.isDefault ? ` ${ct('ui.page.directory.default')}` : ''}
                      </option>
                    ))}
                  </select>
                  <IconChevronDownOutlineRegular size={14} />
                </div>
                <p>
                  {draft.user
                    ? ct('ui.page.directory.user', { user: draft.user })
                    : ct('ui.page.directory.defaultUser')}
                </p>
              </div>
              <div className="dsh-wsl-field">
                <label htmlFor="dsh-wsl-directory">{ct('ui.page.directory.path')}</label>
                <div className="dsh-wsl-directory-row">
                  <Input
                    id="dsh-wsl-directory"
                    className="dsh-wsl-directory-input"
                    value={draft.directory}
                    disabled={disabled}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => edit('directory', event.target.value)}
                    placeholder={ct('ui.page.directory.placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    variant="outline"
                    icon={<IconFolderOpenOutlineRegular />}
                    disabled={disabled || !draft.distro}
                    onClick={() => setPicker(true)}
                  >
                    {ct('ui.common.browse')}
                  </Button>
                </div>
                <p>
                  {profile?.storage === 'windows-mount'
                    ? ct('ui.page.directory.windowsMount')
                    : profile?.storage === 'linux'
                      ? ct('ui.page.directory.linuxStorage')
                      : ct('ui.page.directory.pasteHint')}
                </p>
              </div>
            </div>
            {profile?.recentDirectories?.length ? (
              <div className="dsh-wsl-recents" aria-label={ct('ui.page.directory.recent')}>
                <span>{ct('ui.page.directory.recentLabel')}</span>
                {profile.recentDirectories.slice(0, 5).map((directory) => (
                  <button
                    key={directory}
                    type="button"
                    title={directory}
                    aria-label={ct('ui.page.directory.useDirectory', { directory })}
                    className={directory === draft.directory ? 'is-selected' : ''}
                    disabled={disabled}
                    onClick={() =>
                      task('directory', () => selectEnvironment({ ...chosen(), directory }))
                    }
                  >
                    <IconFolderOpenOutlineRegular size={14} />
                    <span>{directory === '/' ? '/' : directory.split('/').filter(Boolean).pop()}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {!wslHost ? (
              <details className="dsh-wsl-advanced">
                <summary>
                  {ct('ui.page.directory.advanced')}
                  <IconChevronDownOutlineRegular size={12} />
                </summary>
                <div className="dsh-wsl-user-field">
                  <label htmlFor="dsh-wsl-user">{ct('ui.page.directory.userLabel')}</label>
                  <Input
                    id="dsh-wsl-user"
                    value={draft.user}
                    disabled={disabled}
                    placeholder={ct('ui.page.directory.defaultUserShort')}
                    autoComplete="off"
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      edit('user', event.target.value);
                      edit('directory', '');
                    }}
                  />
                  <p>{ct('ui.page.directory.userHint')}</p>
                </div>
              </details>
            ) : null}
            <div className="dsh-wsl-card-actions">
              <div className="dsh-wsl-action-primary">
                <Button
                  variant="outline"
                  type="submit"
                  disabled={disabled || !draft.distro}
                  icon={
                    busy === 'connect' || busy === 'switch' ? (
                      <StateDot state="ongoing" />
                    ) : linuxConnection && !dirty ? (
                      <StateDot state="done" />
                    ) : undefined
                  }
                >
                  {busy === 'connect' || busy === 'switch'
                    ? ct('ui.page.directory.connecting')
                    : dirty
                      ? ct('ui.page.directory.apply')
                      : linuxConnection
                        ? ct('ui.page.directory.connectedShort')
                        : ct('ui.page.directory.connect')}
                </Button>
                {wslHost ? (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      task('windows', async () => {
                        await api('connect', { target: 'windows' });
                        setNotice({ text: ct('ui.page.directory.windowsReady') });
                      })
                    }
                  >
                    {windowsConnected ? ct('ui.page.directory.windowsConnected') : ct('ui.page.directory.connectWindows')}
                  </Button>
                ) : null}
              </div>
              <Button
                variant="ghost"
                icon={<OpenIcon />}
                disabled={disabled || !draft.directory.trim()}
                onClick={() =>
                  task('open', async () => {
                    const result = (await api('open', {
                      path: draft.directory.trim(),
                      distro: draft.distro,
                      user: draft.user,
                    })) as { exitCode: number; stderr?: string };
                    if (result.exitCode !== 0) {
                      throw new Error(result.stderr || ct('ui.page.directory.openFailed'));
                    }
                    setNotice({ text: ct('ui.page.directory.opened') });
                  })
                }
              >
                {ct('ui.page.directory.openInWindows')}
              </Button>
            </div>
          </form>
        </div>
      </section>

      <div className="dsh-wsl-help">
        <IconFolderOpenOutlineRegular size={18} />
        <p>{wslHost ? ct('ui.page.help.linux') : ct('ui.page.help.windows')}</p>
      </div>

      <details className="dsh-wsl-diagnostics">
        <summary>
          {ct('ui.page.diagnostics.title')}
          <IconChevronDownOutlineRegular size={12} />
        </summary>
        <div className="dsh-wsl-diagnostics-body">
          <dl>
            <div>
              <dt>{ct('ui.page.diagnostics.host')}</dt>
              <dd>{wslHost ? 'Linux / WSL' : 'Windows'}</dd>
            </div>
            <div>
              <dt>{ct('ui.page.diagnostics.version')}</dt>
              <dd>{state.version}</dd>
            </div>
            <div>
              <dt>{ct('ui.page.diagnostics.connections')}</dt>
              <dd>{state.pool.connections.filter((connection) => connection.connected).length}</dd>
            </div>
            {linuxConnection ? (
              <>
                <div>
                  <dt>{ct('ui.page.diagnostics.node')}</dt>
                  <dd>{linuxConnection.info?.node}</dd>
                </div>
                <div>
                  <dt>{ct('ui.page.diagnostics.home')}</dt>
                  <dd>{linuxConnection.info?.home}</dd>
                </div>
              </>
            ) : null}
          </dl>
          {native.instances
            ?.filter((item) => item.running)
            .map((item) => (
              <div className="dsh-wsl-runtime-row" key={`${item.settings.distro}/${item.settings.user}`}>
                <div>
                  <strong>{item.settings.distro}</strong>
                  <span>{ct('ui.page.diagnostics.running', { user: item.settings.user })}</span>
                </div>
                <Button
                  variant="outline"
                  disabled={disabled || item.preparing || item.starting}
                  onClick={() => setDialog({ kind: 'stop', settings: item.settings })}
                >
                  {ct('ui.page.diagnostics.stopEnvironment')}
                </Button>
              </div>
            ))}
          {!wslHost ? (
            <div className="dsh-wsl-runtime-row">
              <p>{ct('ui.page.diagnostics.prepareHint')}</p>
              <Button
                variant="outline"
                disabled={disabled || activeWork || !!running || !draft.distro}
                onClick={() =>
                  task('prepare', async () => {
                    await api('native/prepare', chosen());
                  })
                }
              >
                {ct('ui.page.diagnostics.prepare')}
              </Button>
            </div>
          ) : null}
          <div className="dsh-wsl-disconnect-row">
            <p>{ct('ui.page.diagnostics.disconnectHint')}</p>
            <Button
              variant="outline"
              disabled={disabled || activeWork || !state.pool.connections.length}
              onClick={() => setDialog({ kind: 'disconnect' })}
            >
              {ct('ui.page.diagnostics.disconnectAll')}
            </Button>
          </div>
        </div>
      </details>

      {picker ? (
        <DirectoryPicker
          api={api}
          distro={draft.distro}
          user={draft.user}
          initialPath={draft.directory.trim()}
          onClose={() => setPicker(false)}
          onSelect={(directory) => {
            setPicker(false);
            void task('directory', () => selectEnvironment({ ...chosen(), directory }));
          }}
        />
      ) : null}

      <Modal
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'stop' ? ct('ui.page.confirmStop.title') : ct('ui.page.confirmDisconnect.title')}
        closeLabel={ct('ui.common.close')}
        description={
          dialog?.kind === 'stop'
            ? ct('ui.page.confirmStop.description')
            : ct('ui.page.confirmDisconnect.description')
        }
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{ct('ui.common.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const action = dialog;
                setDialog(null);
                void task('stop', async () => {
                  model.conversations.stopRecovery(action?.kind === 'stop' ? action.settings : undefined);
                  await api(action?.kind === 'stop' ? 'native/stop' : 'disconnect', action?.kind === 'stop' ? action.settings : {});
                  model.readyLink = null;
                  setNotice({
                    text:
                      action?.kind === 'stop'
                        ? ct('ui.page.stoppedEnvironment')
                        : ct('ui.page.disconnected'),
                  });
                });
              }}
            >
              {ct('ui.page.confirm')}
            </Button>
          </>
        }
      />
    </div>
  );
}
