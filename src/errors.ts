import { t, type MessageKey, type MessageParams } from './i18n/index.js';

/**
 * Typed failure crossing the plugin, RPC and HTTP boundaries.
 *
 * `code` is a stable machine-readable identifier (the wire contract); the
 * message is localized for humans and may change between releases.
 */
export class BridgeError extends Error {
  override readonly name = 'BridgeError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Thrown value shape after JSON transport, where the class identity is lost. */
export interface ErrorData {
  code: string;
  message: string;
}

/** Narrow an unknown thrown value to a code/message pair. */
export function isErrorWithCode(value: unknown): value is Error & { code: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/** Fail with a localized, coded error unless `test` is truthy. */
export function ensure(
  test: unknown,
  code: string,
  key: MessageKey,
  params?: MessageParams,
): asserts test {
  if (!test) throw new BridgeError(code, t(key, params));
}

/** Validate a non-empty string argument (no NUL, bounded length). */
export function text(value: unknown, name: string, max = 32768): string {
  ensure(
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'),
    'INVALID_ARGUMENT',
    'errors.text',
    { name },
  );
  return value;
}

/** Validate an optional integer argument within an inclusive range. */
export function integer(
  value: unknown,
  fallback: number | undefined,
  min: number,
  max: number,
  name = 'number',
): number {
  if (value === undefined) {
    ensure(fallback !== undefined, 'INVALID_ARGUMENT', 'errors.integer', { name, min, max });
    return fallback;
  }
  ensure(
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max,
    'INVALID_ARGUMENT',
    'errors.integer',
    { name, min, max },
  );
  return value as number;
}

/** Throw when the caller cancelled the operation. */
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BridgeError('ABORTED', t('errors.aborted'));
}

/** Serialize any thrown value for an RPC or HTTP response. */
export function errorData(error: unknown): ErrorData {
  const code = isErrorWithCode(error) ? error.code : 'BRIDGE_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.slice(0, 4096) };
}
