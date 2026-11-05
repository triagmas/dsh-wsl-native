import { aborted } from './errors.js';

/**
 * WSL can announce the Linux listener before the Windows localhost forward
 * catches up. Probe only the launcher's verified loopback URL; this function
 * never changes firewall or WSL network settings.
 */
export async function waitForLocalhost(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  do {
    aborted(options.signal);
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now())));
    const response = await fetch(url, {
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      redirect: 'manual',
    }).catch(() => null);
    const ready = response?.ok || response?.status === 302 || response?.status === 303;
    await response?.body?.cancel().catch(() => {});
    aborted(options.signal);
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}
