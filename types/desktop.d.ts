/**
 * Ambient declarations for the parts of the DSH Desktop shell and React the
 * plugin relies on but that are not present in the published type packages.
 */
import type { DesktopBridge } from '../src/desktop-view.js';

declare global {
  interface Window {
    /** Present only when the panel runs inside DSH Desktop. */
    dshDesktop?: { browser?: DesktopBridge };
  }
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    /** React 18 types predate the `inert` attribute; React 18.3 passes it through. */
    inert?: boolean;
  }
}
