import { createHmac, timingSafeEqual } from 'node:crypto';

/** Maximum age of a signed handoff token. */
const MAX_AGE = 24 * 60 * 60 * 1000;

/** Payload fields carried by a signed handoff. */
export interface HandoffPayload {
  id: string;
  distro: string;
  user: string;
  directory: string;
  parentOrigin: string | null;
  issuedAt?: number;
  proof?: string;
}

/**
 * Normalize a handoff record to the signed field list.
 *
 * Callers may pass either the flat shape (`distro`/`user`/`directory` at the
 * top level) or the launcher record that nests them under `settings`; both
 * produce the same signature, so signing and verification cannot disagree.
 */
function payload(value: HandoffPayload & { settings?: Partial<HandoffPayload> }): string {
  const settings = value.settings ?? value;
  return JSON.stringify([
    value.id,
    settings.distro,
    settings.user,
    settings.directory,
    value.parentOrigin || null,
    value.issuedAt,
  ]);
}

/** Sign a handoff payload with the launcher's per-session secret. */
export function signHandoff<T extends HandoffPayload>(value: T, secret: string, now = Date.now()): T & { issuedAt: number; proof: string } {
  const result = { ...value, issuedAt: now } as T & { issuedAt: number; proof?: string };
  result.proof = createHmac('sha256', secret).update(payload(result)).digest('hex');
  return result as T & { issuedAt: number; proof: string };
}

/** Verify a handoff payload: signature, age and clock skew. */
export function verifyHandoff(value: Partial<HandoffPayload>, secret: string | undefined, now = Date.now()): boolean {
  if (
    !secret ||
    typeof value.issuedAt !== 'number' ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt > now + 120000 ||
    now - value.issuedAt > MAX_AGE ||
    typeof value.proof !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.proof)
  ) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(payload(value as HandoffPayload)).digest();
  return timingSafeEqual(expected, Buffer.from(value.proof, 'hex'));
}
