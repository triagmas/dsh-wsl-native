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

function payload(value: HandoffPayload): string {
  return JSON.stringify([
    value.id,
    value.distro,
    value.user,
    value.directory,
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
