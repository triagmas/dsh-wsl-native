
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { ct } from './i18n/client.js';
import type { MessageKey } from './i18n/en.js';
import type { PanelApi, PanelStatus } from './client-types.js';
import type { PanelModel } from './panel-types.js';

/** Props for the inheritance section. */
export interface InheritanceSectionProps {
  state: PanelStatus;
  model: PanelModel;
  chosen: () => { distro: string; user: string; directory: string };
  task: (kind: string, action: () => Promise<unknown>) => Promise<void>;
  api: PanelApi;
  disabled: boolean;
}

type InheritKey = 'plugins' | 'config' | 'credentials';

/** Which inherited areas exist, in render order. */
const OPTIONS: readonly InheritKey[] = ['plugins', 'config', 'credentials'];

/** Static key maps keep every translation key type-checked. */
const OPTION_LABELS: Record<InheritKey, MessageKey> = {
  plugins: 'ui.inherit.plugins.label',
  config: 'ui.inherit.config.label',
  credentials: 'ui.inherit.credentials.label',
};

const OPTION_DESCRIPTIONS: Record<InheritKey, MessageKey> = {
  plugins: 'ui.inherit.plugins.description',
  config: 'ui.inherit.config.description',
  credentials: 'ui.inherit.credentials.description',
};

/**
 * Inheritance controls: which parts of the main environment the Linux instance
 * follows. The host keeps the merge logic; this section only reports and toggles.
 */
export function InheritanceSection({ state, model, chosen, task, api, disabled }: InheritanceSectionProps) {
  const inheritance = state.native?.inheritance;
  if (state.mode !== 'windows-host' || !inheritance?.available) return null;
  const { options, applied } = inheritance;
  return (
    <section className="dsh-wsl-section" aria-labelledby="dsh-wsl-inheritance-title">
      <div className="dsh-wsl-section-heading">
        <h2 id="dsh-wsl-inheritance-title">{ct('ui.inherit.title')}</h2>
        <span className="dsh-wsl-caption">{ct('ui.inherit.source', { source: inheritance.source ?? '' })}</span>
      </div>
      <div className="dsh-wsl-card dsh-wsl-inheritance">
        <p>{ct('ui.inherit.description')}</p>
        <div className="dsh-wsl-inherit-options">
          {OPTIONS.map((key) => (
            <div className="dsh-wsl-inherit-option" key={key}>
              <div>
                <strong>{ct(OPTION_LABELS[key])}</strong>
                <small>{ct(OPTION_DESCRIPTIONS[key])}</small>
              </div>
              <Switch
                checked={options[key]}
                disabled={disabled}
                label={ct('ui.inherit.toggle', { label: ct(OPTION_LABELS[key]) })}
                onChange={(checked: boolean) =>
                  void task('inheritance', () =>
                    api('native/inheritance', { ...chosen(), options: { [key]: checked } }),
                  )
                }
              />
            </div>
          ))}
        </div>
        <div className="dsh-wsl-inherit-actions">
          <Button
            variant="outline"
            disabled={disabled || !chosen().distro}
            onClick={() => void model.conversations.enter(chosen(), { panel: 'plugins' } as never)}
          >
            {ct('ui.inherit.manage')}
          </Button>
          <span className="dsh-wsl-caption">{ct('ui.inherit.hint')}</span>
        </div>
        {applied ? (
          <details className="dsh-wsl-inherit-details">
            <summary>
              {ct('ui.inherit.summary', {
                count: applied.plugins.filter((plugin) => plugin.status === 'inherited').length,
              })}
              {applied.overrides ? ` · ${ct('ui.inherit.overrides', { count: applied.overrides })}` : ''}
            </summary>
            <ul>
              {applied.plugins.map((plugin) => (
                <li key={plugin.name}>
                  <span>
                    {plugin.name} <small>{plugin.version}</small>
                  </span>
                  <span>
                    {plugin.status === 'inherited'
                      ? ct('ui.inherit.status.inherited')
                      : plugin.status === 'overridden'
                        ? ct('ui.inherit.status.overridden')
                        : plugin.reason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
