/**
 * Which surface is behind a URL?
 *
 * The daemon's `/health` reports `backends[]` when bound to loopback;
 * a bare OpenAI-compatible server answers `/v1/models` instead and
 * often 404s `/health`. Probe in that order, and never assume: a URL
 * that answers neither is reported as unreachable rather than silently
 * switched to demo.
 */

import type { DaemonHealth, RouteTarget } from './types';
import { listModels } from './openai';
import { fetcher } from './http';

export type ProbeKind = 'daemon' | 'openai' | 'unreachable';

export interface ProbeResult {
  kind: ProbeKind;
  health?: DaemonHealth;
  targets?: RouteTarget[];
  error?: string;
  note?: string;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(url: string, timeoutMs: number, doFetch: typeof fetch, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function probe(baseUrl: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const doFetch = fetcher(deps.fetchImpl);
  const timeoutMs = deps.timeoutMs ?? 2500;
  const base = baseUrl.replace(/\/+$/, '');

  try {
    const health = await getJson(`${base}/health`, timeoutMs, doFetch);
    if (health.ok) {
      const body = (await health.json().catch(() => ({}))) as DaemonHealth & Record<string, unknown>;
      if (Array.isArray(body.backends)) {
        return {
          kind: 'daemon',
          health: { status: body.status ?? 'ok', version: body.version, backends: body.backends },
          note: `${body.backends.length} backend${body.backends.length === 1 ? '' : 's'} reported`,
        };
      }
      // Something answers /health but exposes no roster (non-loopback
      // daemon bind leaks only {status}). Ask the ticket route before
      // calling it a daemon.
      if (String(body.status) === 'ok') {
        return {
          kind: 'daemon',
          health: { status: 'ok', version: typeof body.version === 'string' ? body.version : undefined },
          note: 'daemon answered (roster hidden on a non-loopback bind)',
        };
      }
    }
  } catch {
    /* fall through to the OpenAI probe */
  }

  try {
    const response = await getJson(`${base}/v1/models`, timeoutMs, doFetch);
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string; owned_by?: string }> };
      const targets = await listModels({ baseUrl: base, fetchImpl: doFetch }).catch(() => []);
      return {
        kind: 'openai',
        targets,
        note: `${Array.isArray(body.data) ? body.data.length : targets.length} models on /v1/models`,
      };
    }
  } catch {
    /* unreachable below */
  }

  return { kind: 'unreachable', error: 'no daemon on /health and no /v1/models — is it running?' };
}
