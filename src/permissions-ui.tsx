import { useState } from 'react';
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { useModel } from './page.js';
import { ct, formatDate } from './i18n/client.js';
import type { MessageKey } from './i18n/en.js';
import type { PermissionMode, PermissionView, PanelApi } from './client-types.js';
import type { PanelModel } from './panel-types.js';

/** Modes in escalating order, used for both rendering and validation. */
const MODES: PermissionMode[] = ['protected', 'trusted', 'full-access'];

/** One row in the mode list. */
interface ModeOption {
  mode: PermissionMode;
  title: MessageKey;
  description: MessageKey;
}

const OPTIONS: ModeOption[] = [
  { mode: 'protected', title: 'permissions.mode.protected', description: 'permissions.mode.protected.description' },
  { mode: 'trusted', title: 'permissions.mode.trusted', description: 'permissions.mode.trusted.description' },
  { mode: 'full-access', title: 'permissions.mode.fullAccess', description: 'permissions.mode.fullAccess.description' },
];

/** Capability labels, typed so a missing key fails the build. */
const CAPABILITY_LABELS: Record<(typeof CAPABILITIES)[number], MessageKey> = {
  exec: 'ui.permissions.capability.exec',
  write: 'ui.permissions.capability.write',
  copy: 'ui.permissions.capability.copy',
};

/** Grant lifetimes offered in the add form. */
const HOURS = [1, 4, 8, 24] as const;

/** Capability presets offered in the add form. */
const CAPABILITIES = ['exec', 'write', 'copy'] as const;

/** Format an expiry timestamp, or the "no expiry" label. */
function expiryText(value: number | null): string {
  if (value === null) return ct('ui.permissions.neverExpires');
  const remaining = value - Date.now();
  if (remaining <= 0) return ct('ui.permissions.expired');
  const minutes = Math.max(1, Math.round(remaining / 60000));
  const hours = Math.floor(minutes / 60);
  return hours >= 1
    ? ct('ui.permissions.expiresInHours', { hours, minutes: minutes % 60 })
    : ct('ui.permissions.expiresInMinutes', { minutes });
}

/** Props of the permission section. */
export interface PermissionsSectionProps {
  model: PanelModel;
  api: PanelApi;
  disabled?: boolean;
}

/**
 * Permission panel: shows the active mode, its expiry and every standing grant,
 * and lets the user change them through the authenticated control route.
 *
 * The agent can never call these actions: the host mints the authority for this
 * component from the authenticated control route, so a rendered button is
 * evidence of an authenticated user surface, not of an agent request.
 */
export function PermissionsSection({ model, api, disabled }: PermissionsSectionProps) {
  useModel(model);
  const state = model.state;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [capability, setCapability] = useState<(typeof CAPABILITIES)[number]>('exec');
  const [target, setTarget] = useState('');
  const [hours, setHours] = useState<number>(4);

  if (!state) return null;
  const permissions: PermissionView = state.permissions;
  const modeExpiresAt = permissions.modeExpiresAt;
  const blocked = !!disabled || !!busy;
  const expiry =
    modeExpiresAt != null
      ? expiryText(modeExpiresAt)
      : permissions.mode === 'protected'
        ? null
        : ct('ui.permissions.noExpiry');

  const change = (mode: PermissionMode): void => {
    if (blocked || mode === permissions.mode) return;
    setBusy(mode);
    setError('');
    void api('permissions/mode', { mode })
      .then(() => model.refresh())
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(''));
  };

  const addGrant = (): void => {
    if (blocked || !target.trim()) return;
    setBusy('grant');
    setError('');
    void api('permissions/grant', { capability, target: target.trim(), hours })
      .then(() => {
        setAdding(false);
        setTarget('');
        return model.refresh();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(''));
  };

  const revoke = (id: string): void => {
    if (blocked) return;
    setBusy(id);
    setError('');
    void api('permissions/revoke', { id })
      .then(() => model.refresh())
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(''));
  };

  return (
    <section className="dsh-wsl-section dsh-wsl-permissions" aria-labelledby="dsh-wsl-permissions-title">
      <div className="dsh-wsl-section-heading">
        <h2 id="dsh-wsl-permissions-title">{ct('ui.permissions.title')}</h2>
        <span className="dsh-wsl-caption">{ct('ui.permissions.caption')}</span>
      </div>
      <div className="dsh-wsl-card">
        <div className="dsh-wsl-permission-modes" role="radiogroup" aria-label={ct('ui.permissions.modeLabel')}>
          {OPTIONS.map((option) => {
            const active = permissions.mode === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={active}
                className={`dsh-wsl-permission-mode${active ? ' is-active' : ''}`}
                disabled={blocked}
                onClick={() => change(option.mode)}
              >
                <span className="dsh-wsl-permission-mode-name">
                  <StateDot state={active ? 'done' : 'idle'} />
                  {ct(option.title)}
                  {busy === option.mode ? <StateDot state="ongoing" /> : null}
                </span>
                <span className="dsh-wsl-caption">{ct(option.description)}</span>
              </button>
            );
          })}
        </div>
        {expiry ? (
          <p className="dsh-wsl-permission-expiry">
            {ct('ui.permissions.modeExpiry')}: <strong>{expiry}</strong>
            {modeExpiresAt != null ? ` · ${formatDate(modeExpiresAt)}` : ''}
          </p>
        ) : null}
        <p className="dsh-wsl-caption">{ct('ui.permissions.readOnlyNotice')}</p>

        <div className="dsh-wsl-permission-grants">
          <div className="dsh-wsl-permission-grants-head">
            <h3>{ct('ui.permissions.grants')}</h3>
            <Button size="sm" variant="ghost" disabled={blocked} onClick={() => setAdding(!adding)}>
              {adding ? ct('ui.common.cancel') : ct('ui.permissions.addGrant')}
            </Button>
          </div>
          {adding ? (
            <form
              className="dsh-wsl-permission-form"
              onSubmit={(event) => {
                event.preventDefault();
                addGrant();
              }}
            >
              <label>
                {ct('ui.permissions.grantCapability')}
                <select
                  value={capability}
                  disabled={blocked}
                  onChange={(event) => setCapability(event.target.value as (typeof CAPABILITIES)[number])}
                >
                  {CAPABILITIES.map((item) => (
                    <option key={item} value={item}>
                      {ct(CAPABILITY_LABELS[item])}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ct('ui.permissions.grantTarget')}
                <Input
                  value={target}
                  disabled={blocked}
                  placeholder={ct('ui.permissions.targetPlaceholder')}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTarget(event.target.value)}
                />
              </label>
              <label>
                {ct('ui.permissions.grantHours')}
                <select
                  value={hours}
                  disabled={blocked}
                  onChange={(event) => setHours(Number(event.target.value))}
                >
                  {HOURS.map((item) => (
                    <option key={item} value={item}>
                      {ct('ui.permissions.hoursOption', { hours: item })}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" type="submit" disabled={blocked || !target.trim()}>
                {ct('ui.permissions.grantCreate')}
              </Button>
            </form>
          ) : null}
          {permissions.grants.length ? (
            <ul className="dsh-wsl-permission-list">
              {permissions.grants.map((grant) => (
                <li key={grant.id}>
                  <div>
                    <strong>{grant.capability}</strong>
                    <span title={grant.target}>{grant.target}</span>
                    <small>
                      {ct('ui.permissions.expires', { time: expiryText(grant.expiresAt) })}
                      {grant.root ? ` · ${ct('ui.permissions.grantRoot')}: ${grant.root}` : ''}
                    </small>
                  </div>
                  <Button size="sm" variant="ghost" disabled={blocked} onClick={() => revoke(grant.id)}>
                    {ct('ui.permissions.grantRevoke')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dsh-wsl-caption">{ct('ui.permissions.noGrants')}</p>
          )}
        </div>
        {error ? (
          <div role="alert" className="dsh-wsl-inline-error">
            {error}
          </div>
        ) : null}
        <p className="dsh-wsl-caption dsh-wsl-permissions-limit">{ct('ui.permissions.fullAccessWarning')}</p>
      </div>
    </section>
  );
}

/** True when `mode` is one the panel knows how to render. */
export function isPermissionMode(mode: string): mode is PermissionMode {
  return (MODES as string[]).includes(mode);
}
