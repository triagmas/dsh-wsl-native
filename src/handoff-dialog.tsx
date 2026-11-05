import { useMemo, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { handoffText, type HandoffSource } from './work-handoff.js';
import { ct } from './i18n/client.js';
import type { EnvironmentSettings } from './client-types.js';
import type { ConversationEntry } from './conversation-model.js';
import type { PanelModel } from './panel-types.js';

/** One selectable target environment in the dialog. */
interface TargetEnvironment {
  key: string;
  label: string;
  entry: ConversationEntry | null;
  settings: EnvironmentSettings | null;
}

/** Props for the cross-environment handoff dialog. */
export interface HandoffDialogProps {
  model: PanelModel;
  source: HandoffSource & { entry?: ConversationEntry | null };
  close: () => void;
}

/** Kind and id encoded in one `<option>` value. */
type TargetChoice = ['workspace' | 'session', string];

/**
 * Move work from one environment to another. The dialog only prepares the
 * text and the target; the delivery, duplicate protection and draft handling
 * live in `work-handoff.ts` and stay usable without this UI.
 */
export function HandoffDialog({ model, source, close }: HandoffDialogProps) {
  const chat = model.conversations;
  const environments = useMemo<TargetEnvironment[]>(
    () => [
      { key: 'windows', label: 'Windows', entry: null, settings: null },
      ...[...chat.entries.values()].map((entry) => ({
        key: entry.key,
        entry,
        settings: entry.settings,
        label:
          `WSL · ${entry.settings.distro}` + (entry.settings.user ? ` · ${entry.settings.user}` : ''),
      })),
    ].filter((environment) => environment.key !== (source.entry?.key ?? 'windows')),
    [source, chat],
  );
  const [environment, setEnvironment] = useState(environments[0]?.key ?? '');
  const [target, setTarget] = useState('');
  const [notes, setNotes] = useState('');
  const [recent, setRecent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transferId, setTransferId] = useState(() => crypto.randomUUID());
  const selected = environments.find((environment_) => environment_.key === environment);
  const text = handoffText(source as HandoffSource, notes, recent);
  const tooLong = text.length > 24000;

  const read = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const result = (await chat.handoff(source.entry, 'handoff.read', { sessionId: source.id })) as {
        text?: string;
      };
      setRecent(result.text ?? '');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deliver = async (mode: 'draft' | 'send'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const [kind, id] = JSON.parse(target) as TargetChoice;
      await chat.handoff(selected?.entry ?? null, 'handoff.deliver', {
        transferId,
        mode,
        text,
        [kind === 'workspace' ? 'workspaceId' : 'sessionId']: id,
      });
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const blocked = busy || !target || (!notes.trim() && !recent.trim()) || tooLong;
  const disabledClose = busy ? () => {} : close;
  return (
    <Modal
      open
      title={ct('ui.handoff.title')}
      closeLabel={ct('ui.handoff.closeLabel')}
      onClose={disabledClose}
      description={ct('ui.handoff.description', {
        system: source.entry ? `WSL · ${source.entry.settings.distro}` : 'Windows',
        title: source.row.title || ct('ui.common.newConversation'),
      })}
      className="dsh-wsl-picker"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {ct('ui.common.cancel')}
          </Button>
          <Button variant="outline" disabled={blocked} onClick={() => void deliver('draft')}>
            {ct('ui.handoff.draft')}
          </Button>
          <Button variant="primary" disabled={blocked} onClick={() => void deliver('send')}>
            {ct('ui.handoff.send')}
          </Button>
        </>
      }
    >
      <div className="dsh-wsl-dialog-form">
        {environments.length === 0 ? (
          <p>{ct('ui.handoff.noEnvironments')}</p>
        ) : (
          <>
            <label>
              {ct('ui.handoff.targetEnv')}
              <select
                value={environment}
                disabled={busy}
                onChange={(event) => {
                  setEnvironment(event.target.value);
                  setTarget('');
                  setTransferId(crypto.randomUUID());
                }}
              >
                {environments.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {ct('ui.handoff.targetChat')}
              <select
                value={target}
                disabled={busy}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setTransferId(crypto.randomUUID());
                }}
              >
                <option value="">{ct('ui.handoff.chooseTarget')}</option>
                <optgroup label={ct('ui.handoff.newChat')}>
                  {(selected?.entry?.catalog?.workspaces ?? []).map((workspace) => (
                    <option
                      key={workspace.workspaceId}
                      value={JSON.stringify(['workspace', workspace.workspaceId])}
                    >
                      {ct('ui.handoff.workspaceOption', {
                        title: workspace.title || workspace.path,
                      })}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={ct('ui.handoff.existingChat')}>
                  {(selected?.entry?.catalog?.rows ?? [])
                    .filter((row) => !row.archived)
                    .map((row) => (
                      <option key={row.id} value={JSON.stringify(['session', row.id])}>
                        {(row.title || ct('ui.common.newConversation')) +
                          (row.running ? ` · ${ct('ui.handoff.sessionRunning')}` : '')}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
          </>
        )}
        <label>
          {ct('ui.handoff.notes')}
          <textarea
            value={notes}
            disabled={busy}
            maxLength={20000}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={ct('ui.handoff.notesPlaceholder')}
          />
        </label>
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void read()}>
            {ct('ui.handoff.recent')}
          </Button>
          <span className="dsh-wsl-caption"> {ct('ui.handoff.recentHint')}</span>
        </div>
        {recent ? (
          <label>
            {ct('ui.handoff.excerpt')}
            <textarea
              value={recent}
              disabled={busy}
              onChange={(event) => setRecent(event.target.value)}
            />
          </label>
        ) : null}
        <details>
          <summary>{ct('ui.handoff.preview')}</summary>
          <pre className="dsh-wsl-handoff-preview">{text}</pre>
        </details>
        <p className="dsh-wsl-caption">{ct('ui.handoff.footnote')}</p>
        {tooLong ? <p role="alert">{ct('ui.handoff.tooLong')}</p> : null}
        {error ? (
          <p role="alert" className="dsh-wsl-inline-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
