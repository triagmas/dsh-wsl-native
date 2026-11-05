/**
 * The literal phrase a user must type to enable Full Access.
 *
 * It lives in its own module because the browser bundle needs the same string:
 * `permissions/index.ts` imports Node's crypto and cannot be loaded in the panel.
 */
export const FULL_ACCESS_PHRASE = 'FULL ACCESS';
