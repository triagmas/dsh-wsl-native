import { useState } from 'react';
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { useModel } from './page.js';
import { ct, formatDate } from './i18n/client.js';
import { FULL_ACCESS_PHRASE } from './permissions/phrase.js';
import {
  FULL_ACCESS_MINUTES,
  GRANT_CAPABILITIES,
  GRANT_HOURS,
  GRANT_TARGETS,
  buildGrantRequest,
  buildModeRequest,
  minutesLabelKey,
  minutesLabelParams,
  needsRoot,
  type GrantCapability,
  type GrantTarget,
} from './permissions-form.js';
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
const CAPABILITY_LABELS: Record<GrantCapability, MessageKey> = {
  exec: 'ui.permissions.capability.exec',
  write: 'ui.permissions.capability.write',
  copy: 'ui.permissions.capability.copy',
};

/** Target labels; the names are the same in every language. */
const TARGET_LABELS: Record<GrantTarget, string> = { windows: 'Windows', wsl: 'WSL' };

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
 * Permission panel: the active mode with its expiry, the Full Access
 * confirmation form, and the standing grants with add and revoke.
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
  const [confirming, setConfirming] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [minutes, setMinutes] = useState<number>(60);
  const [adding, setAdding] = useState(false);
  const [capability, setCapability] = useState<GrantCapability>('write');
  const [target, setTarget] = useState<GrantTarget>('wsl');
  const [root, setRoot] = useState('');
  const [hours, setHours] = useState<number>(8);

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
  const rootNeeded = needsRoot(capability);

  const applyMode = (mode: PermissionMode, phrase: string, lifetime: number): void => {
    const built = buildModeRequest(mode, phrase, lifetime);
    if (!built.ok) {
      setError(ct(built.error));
      return;
    }
    setBusy(mode);
    setError('');
    void api('permissions/mode', built.value)
      .then(() => {
        setConfirming(false);
        setConfirm('');
        return model.refresh();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(''));
  };

  const chooseMode = (mode: PermissionMode): void => {
    if (blocked || mode === permissions.mode) return;
    setError('');
    if (mode === 'full-access') {
      // Turning Full Access on always goes through the phrase and the lifetime.
      setConfirm('');
      setConfirming(true);
      return;
    }
    setConfirming(false);
    applyMode(mode, '', minutes);
  };

  const addGrant = (): void => {
    if (blocked) return;
    const built = buildGrantRequest({ capability, target, root, hours });
    if (!built.ok) {
      setError(ct(built.error));
      return;
    }
    setBusy('grant');
    setError('');
    void api('permissions/grant', built.value)
      .then(() => {
        setAdding(false);
        setRoot('');
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
                onClick={() => chooseMode(option.mode)}
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
        {confirming ? (
          <div className="dsh-wsl-permission-confirm">
            <label>
              {ct('ui.permissions.confirmPhrase')}
              <Input
                value={confirm}
                disabled={blocked}
                placeholder={FULL_ACCESS_PHRASE}
                autoComplete="off"
                spellCheck={false}
                aria-label={ct('ui.permissions.confirmPhrase')}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  setConfirm(event.target.value);
                  setError('');
                }}
              />
            </label>
            <label>
              {ct('ui.permissions.fullAccessDuration')}
              <select
                value={minutes}
                disabled={blocked}
                onChange={(event) => setMinutes(Number(event.target.value))}
              >
                {FULL_ACCESS_MINUTES.map((value) => (
                  <option key={value} value={value}>
                    {ct(minutesLabelKey(value), minutesLabelParams(value))}
                  </option>
                ))}
              </select>
            </label>
            <p className="dsh-wsl-caption">{ct('ui.permissions.confirmFullAccess')}</p>
            <div className="dsh-wsl-permission-confirm-actions">
              <Button
                variant="primary"
                disabled={blocked || confirm !== FULL_ACCESS_PHRASE}
                onClick={() => applyMode('full-access', confirm, minutes)}
              >
                {ct('ui.permissions.switchMode')}
              </Button>
              <Button
                variant="ghost"
                disabled={blocked}
                onClick={() => {
                  setConfirming(false);
                  setConfirm('');
                  setError('');
                }}
              >
                {ct('ui.common.cancel')}
              </Button>
            </div>
            {confirm && confirm !== FULL_ACCESS_PHRASE ? (
              <p className="dsh-wsl-caption dsh-wsl-permission-warning">{ct('ui.permissions.confirmRequired')}</p>
            ) : null}
          </div>
        ) : null}
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
                  onChange={(event) => {
                    const next = event.target.value as GrantCapability;
                    setCapability(next);
                    // Exec covers the whole target, so a folder would be rejected.
                    if (!needsRoot(next)) setRoot('');
                    setError('');
                  }}
                >
                  {GRANT_CAPABILITIES.map((item) => (
                    <option key={item} value={item}>
                      {ct(CAPABILITY_LABELS[item])}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ct('ui.permissions.grantTarget')}
                <select
                  value={target}
                  disabled={blocked}
                  onChange={(event) => setTarget(event.target.value as GrantTarget)}
                >
                  {GRANT_TARGETS.map((item) => (
                    <option key={item} value={item}>
                      {TARGET_LABELS[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ct('ui.permissions.rootOptional')}
                <Input
                  value={root}
                  disabled={blocked || !rootNeeded}
                  placeholder={target === 'windows' ? 'C:\\' : '/'}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={ct('ui.permissions.grantRoot')}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setRoot(event.target.value);
                    setError('');
                  }}
                />
              </label>
              <label>
                {ct('ui.permissions.grantHours')}
                <select
                  value={hours}
                  disabled={blocked}
                  onChange={(event) => setHours(Number(event.target.value))}
                >
                  {GRANT_HOURS.map((item) => (
                    <option key={item} value={item}>
                      {ct('ui.permissions.hoursOption', { hours: item })}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="primary" type="submit" disabled={blocked || (rootNeeded && !root.trim())}>
                {ct('ui.permissions.grantCreate')}
              </Button>
              <p className="dsh-wsl-caption">
                {rootNeeded ? ct('ui.permissions.rootRequired') : ct('ui.permissions.execNoRoot')}
              </p>
            </form>
          ) : null}
          {permissions.grants.length ? (
            <ul className="dsh-wsl-permission-list">
              {permissions.grants.map((grant) => (
                <li key={grant.id}>
                  <div>
                    <strong>{grant.capability}</strong>
                    <span>
                      {grant.target === 'windows' ? 'Windows' : 'WSL'}
                      {grant.root ? ` · ${grant.root}` : ''}
                    </span>
                    <small>{ct('ui.permissions.expires', { time: expiryText(grant.expiresAt) })}</small>
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
