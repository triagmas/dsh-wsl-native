import { BridgeError, aborted } from './errors.js';
import { t, getLocale, translate } from './i18n/index.js';
import type { MessageKey, MessageParams } from './i18n/index.js';

/** Minimal structural view of the cordis context the plugin needs. */
export interface PolicyContext {
  get(name: string): unknown;
}

/** Approval outcome vocabulary owned by `@deepseek-ai/dsh-user-approval`. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** Structural view of one approval request. */
export interface ApprovalRequest {
  agent: unknown;
  toolName: string;
  callId?: unknown;
  reason?: string;
  /** Localized presentation only; the audit log keeps `reason`. */
  displayReason?: { readonly en: string; readonly [locale: string]: string };
  signal?: AbortSignal;
}

/** Structural view of `ctx.approval`. */
export interface ApprovalService {
  request(request: ApprovalRequest): Promise<ApprovalOutcome>;
}

/** Structural view of the tool execution context handed to `execute`. */
export interface ToolExec {
  name: string;
  callId?: unknown;
  signal: AbortSignal;
  agent?: { session?: unknown };
}

/** A reason rendered once for every configured locale. */
export interface LocalizedReason {
  readonly en: string;
  readonly [locale: string]: string;
}

/** Build the localized reason payload the DSH approval UI understands. */
export function localizedReason(key: MessageKey, params?: MessageParams): LocalizedReason {
  const active = getLocale();
  return {
    en: translate('en', key, params),
    ...(active === 'en' ? {} : { [active]: translate(active, key, params) }),
  };
}

/** Join two localized reasons, keeping every locale in step. */
export function mergeReason(first: LocalizedReason, second: LocalizedReason): LocalizedReason {
  const merged: Record<string, string> & { en: string } = { en: `${first.en} ${second.en}` };
  for (const key of Object.keys(second)) {
    if (key === 'en') continue;
    const head = first[key];
    merged[key] = typeof head === 'string' ? `${head} ${second[key]}` : second[key];
  }
  for (const key of Object.keys(first)) {
    if (key === 'en' || merged[key] !== undefined) continue;
    merged[key] = first[key];
  }
  return merged;
}

/**
 * Ask through DSH's own approval seam.
 *
 * Cross-kernel execution cannot inherit the other operating system's sandbox,
 * so the only truthful protection is a human decision per call. This function
 * therefore fails closed: without an approval service or an agent it refuses
 * the operation instead of running it unapproved.
 */
export async function authorize(
  ctx: PolicyContext,
  exec: ToolExec,
  reason: LocalizedReason,
): Promise<void> {
  aborted(exec.signal);
  const approval = ctx.get('approval') as ApprovalService | undefined;
  if (!approval || !exec.agent) {
    throw new BridgeError(
      'CROSS_OS_PERMISSION',
      t('errors.crossOsPermission', { reason: reason.en }),
    );
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason: reason.en,
    displayReason: reason,
    signal: exec.signal,
  });
  aborted(exec.signal);
  if (outcome !== 'allowed-once') {
    throw new BridgeError('CROSS_OS_PERMISSION', t('errors.notApproved'));
  }
}
