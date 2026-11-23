/**
 * What the header banner says when the desk cannot talk to its backend.
 * Two different failures, two different fixes: no network at all (the
 * shell came from the service worker cache) versus a network that works
 * but nothing answers at the configured URL.
 */

import type { ConnectionState } from './types';

export type ReachKind = 'offline' | 'unreachable' | 'failed' | 'demo-offline';

export interface ReachNotice {
  kind: ReachKind;
  title: string;
  detail: string;
  /** Offer "다시 시도" — re-probe the same URL. */
  retry: boolean;
  /** Offer "데모로 전환" — the simulator needs no network. */
  demo: boolean;
}

export function reachNotice(connection: ConnectionState, online: boolean): ReachNotice | null {
  if (connection.transport === 'demo') {
    if (online) return null;
    return {
      kind: 'demo-offline',
      title: '오프라인 — 데모 모드는 계속 동작합니다',
      detail: '시뮬레이션된 데몬은 네트워크를 쓰지 않습니다. 대화는 이 브라우저에 남습니다.',
      retry: false,
      demo: false,
    };
  }
  const surface = connection.transport === 'daemon' ? '데몬' : '서버';
  if (!online) {
    return {
      kind: 'offline',
      title: `오프라인 — ${surface}에 닿지 않음`,
      detail: `네트워크가 없습니다. 앱은 캐시에서 열렸지만 ${connection.baseUrl}에 연결할 수 없습니다. 네트워크가 돌아오면 자동으로 다시 연결합니다.`,
      retry: true,
      demo: true,
    };
  }
  if (connection.status === 'offline') {
    return {
      kind: 'unreachable',
      title: `${surface}에 닿지 않음`,
      detail:
        connection.transport === 'daemon'
          ? `${connection.baseUrl}의 /health가 응답하지 않습니다 — 데몬이 실행 중인지, 주소와 /dm 프록시가 맞는지 확인하세요.`
          : `${connection.baseUrl}의 /v1/models가 응답하지 않습니다 — 서버가 실행 중인지, 주소가 맞는지 확인하세요.`,
      retry: true,
      demo: true,
    };
  }
  if (connection.status === 'error') {
    return {
      kind: 'failed',
      title: `${surface} 연결 실패`,
      detail: connection.error ?? connection.probeNote ?? '연결 중 오류가 났습니다.',
      retry: true,
      demo: true,
    };
  }
  return null;
}
