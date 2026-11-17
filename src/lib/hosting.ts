/**
 * Where the desk is served, and what that surface can reach.
 *
 * The desk is a static bundle: GitHub Pages (https, public host) cannot
 * open `http://127.0.0.1` — mixed content and Private Network Access
 * block it — so a visitor whose saved settings point at a loopback
 * daemon must land in demo mode instead of a dead `offline` screen.
 */

import type { TransportKind } from './types';

export interface PageOrigin {
  protocol: string;
  hostname: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** `[::1]` and `::1` are the same host; brackets are URL syntax only. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return LOOPBACK_HOSTS.has(host);
}

/** The host a base URL points at; null for relative paths and non-URLs. */
export function hostOf(url: string): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The page's own origin; null outside a browser (tests, SSR). */
export function pageOrigin(): PageOrigin | null {
  if (typeof location === 'undefined') return null;
  return { protocol: location.protocol, hostname: location.hostname };
}

/**
 * True when the saved connection cannot work from this page: an https
 * page on a public host cannot reach this machine's loopback daemon.
 * Any other pairing (http, localhost dev, a proxied remote daemon) is
 * left to the probe, which reports what actually answered.
 */
export function needsDemoFallback(
  transport: TransportKind,
  baseUrl: string,
  origin: PageOrigin | null,
): boolean {
  if (!origin || transport === 'demo') return false;
  if (origin.protocol !== 'https:' || isLoopbackHost(origin.hostname)) return false;
  const host = hostOf(baseUrl);
  return !!host && isLoopbackHost(host);
}

/**
 * `VITE_BASE_PATH` → a Vite `base`. GitHub Pages needs
 * `VITE_BASE_PATH=/damon-chat-desk/`; everything else can keep `/`.
 */
export function resolveBasePath(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return value ? `/${value}/` : '/';
}
