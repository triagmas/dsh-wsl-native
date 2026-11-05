import { useState } from 'react';
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { DirectoryPicker, normalized } from './components.js';
import { useModel } from './page.js';
import { HandoffDialog } from './handoff-dialog.js';
import { ct } from './i18n/client.js';
import type { EnvironmentSettings, PanelApi } from './client-types.js';
import type { PanelModel } from './panel-types.js';
import type { ConversationRow } from './conversation-protocol.js';
import type { ConversationEntry } from './conversation-model.js';

/** Dialog props shared by the workspace dialogs. */
interface DialogProps {
  model: PanelModel;
  close: () => void;
}

type Draft = { distro: string; user: string; directory: string };

function CreateWorkspace({ model, api, close }: DialogProps & { api: PanelApi }) {
  const chat = model.conversations;
  const [settings, setSettings] = useState<Draft>(() =>
    normalized(chat.entries.get(chat.activeKey ?? '')?.settings ?? model.state?.settings ?? {}, model.state?.distros),
  );
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (path: string): Promise<void> => {
    setPicking(false);
    setSettings((value) => ({ ...value, directory: path }));
    setBusy(true);
    setError('');
    await chat.enter({ ...settings, directory: path }, { create: true });
    setBusy(false);
    if (chat.error) setError(chat.error);
    else close();
  };

  if (picking) {
    return (
      <DirectoryPicker
        api={api}
        distro={settings.distro}
        user={settings.user}
        initialPath={settings.directory}
        allowCreate
        onClose={() => setPicking(false)}
        onSelect={(path) => void create(path)}
      />
    );
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : close}
      title={ct('ui.workspace.createTitle')}
      closeLabel={ct('ui.common.close')}
      description={ct('ui.workspace.createDescription')}
      className="dsh-wsl-picker"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {ct('ui.common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !settings.distro || !settings.directory.trim()}
            onClick={() => void create(settings.directory.trim())}
          >
            {busy ? ct('ui.workspace.opening') : ct('ui.workspace.create')}
          </Button>
        </>
      }
    >
      <div className="dsh-wsl-dialog-form">
        <label>
          {ct('ui.workspace.distro')}
          <select
            value={settings.distro}
            disabled={busy}
            onChange={(event) => setSettings({ distro: event.target.value, user: '', directory: '' })}
          >
            {(model.state?.distros ?? []).map((distro) => (
              <option key={distro.name}>{distro.name}</option>
            ))}
          </select>
        </label>
        <label>
          {ct('ui.workspace.user')}
          <Input
            value={settings.user}
            disabled={busy}
            placeholder={ct('ui.workspace.defaultUser')}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSettings({ ...settings, user: event.target.value })}
          />
        </label>
        <label>
          {ct('ui.workspace.folder')}
          <div className="dsh-wsl-pathbar">
            <Input
              value={settings.directory}
              disabled={busy}
              placeholder={ct('ui.workspace.folderPlaceholder')}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setSettings({ ...settings, directory: event.target.value })
              }
            />
            <Button variant="outline" disabled={busy || !settings.distro} onClick={() => setPicking(true)}>
              {ct('ui.common.browse')}
            </Button>
          </div>
        </label>
        <p className="dsh-wsl-caption">{ct('ui.workspace.note')}</p>
        {error ? (
          <div role="alert" className="dsh-wsl-inline-error">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function RenameSession({ model, target, close }: DialogProps & { target: ConversationRow }) {
  const [title, setTitle] = useState(target.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entry = target.environment ? model.conversations.entries.get(target.environment.key) : null;

  const submit = async (): Promise<void> => {
    if (!entry) return;
    setBusy(true);
    setError('');
    try {
      await model.conversations.remote(entry, 'session.rename', { sessionId: target.id, title });
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : close}
      title={ct('ui.workspace.renameTitle')}
      closeLabel={ct('ui.common.close')}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {ct('ui.common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
            {ct('ui.common.save')}
          </Button>
        </>
      }
    >
      <form
        className="dsh-wsl-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && title.trim()) void submit();
        }}
      >
        <Input
          data-modal-autofocus
          value={title}
          maxLength={500}
          aria-label={ct('ui.workspace.name')}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)}
        />
        {error ? <div role="alert">{error}</div> : null}
      </form>
    </Modal>
  );
}

function ArchiveSession({ model, target, close }: DialogProps & { target: ConversationRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entry = target.environment ? model.conversations.entries.get(target.environment.key) : null;

  const submit = async (): Promise<void> => {
    if (!entry) return;
    setBusy(true);
    try {
      await model.conversations.remote(entry, 'archive', { sessionId: target.id, stopActivity: true });
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={ct('ui.workspace.archiveTitle')}
      closeLabel={ct('ui.common.close')}
      onClose={busy ? () => {} : close}
      description={ct('ui.workspace.archiveDescription')}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {ct('ui.common.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {ct('ui.workspace.stopAndArchive')}
          </Button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}
    </Modal>
  );
}

/** All workspace dialogs, driven by `conversations.dialog`. */
export function WorkspaceDialogs({ model, api }: { model: PanelModel; api: PanelApi }) {
  useModel(model);
  const dialog = model.conversations.dialog;
  const close = () => {
    model.conversations.dialog = null;
    model.emit();
  };
  if (!dialog) {
    return model.conversations.error && !model.conversations.visible() ? (
      <div role="alert" className="dsh-wsl-operation-error">
        <span>{model.conversations.error}</span>
        <Button
          variant="ghost"
          aria-label={ct('ui.error.dismiss')}
          onClick={() => {
            model.conversations.error = null;
            model.emit();
          }}
        >
          ×
        </Button>
      </div>
    ) : null;
  }
  if (dialog.type === 'workspace') return <CreateWorkspace model={model} api={api} close={close} />;
  if (dialog.type === 'rename') return <RenameSession model={model} target={dialog.target} close={close} />;
  if (dialog.type === 'archive') return <ArchiveSession model={model} target={dialog.target} close={close} />;
  if (dialog.type === 'handoff') return <HandoffDialog model={model} source={dialog.source} close={close} />;
  return null;
}

/** Settings helper kept for callers that only have a partial environment. */
export function draftFrom(settings: Partial<EnvironmentSettings>): Draft {
  return { distro: settings.distro ?? '', user: settings.user ?? '', directory: settings.directory ?? '' };
}

/** Conversation entry lookup used by the rename dialog. */
export type { ConversationEntry };
