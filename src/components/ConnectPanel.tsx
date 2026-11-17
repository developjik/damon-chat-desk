import { useEffect, useState } from 'react';
import type { DeskState } from '../lib/desk';
import type { TransportKind } from '../lib/types';

interface ConnectPanelProps {
  open: boolean;
  state: DeskState;
  onClose: () => void;
  onConnect: (transport: TransportKind, baseUrl: string, opts: { masterToken?: string; deviceToken?: string }) => void;
  onDemo: () => void;
  onPair: (key: string, name: string) => void;
  onCheckPairing: () => void;
}

type Tab = 'demo' | 'daemon' | 'openai';

export function ConnectPanel({ open, state, onClose, onConnect, onDemo, onPair, onCheckPairing }: ConnectPanelProps) {
  const current: Tab = state.connection.transport === 'openai' ? 'openai' : state.connection.transport === 'daemon' ? 'daemon' : 'demo';
  const [tab, setTab] = useState<Tab>(current);
  const [baseUrl, setBaseUrl] = useState(
    state.connection.transport === 'demo' ? 'http://127.0.0.1:9470' : state.connection.baseUrl,
  );
  const [token, setToken] = useState(state.savedMasterToken ?? '');
  const [deviceToken, setDeviceToken] = useState(state.savedDeviceToken ?? '');
  const [pairingKey, setPairingKey] = useState('');
  const [deviceName, setDeviceName] = useState('chat desk (browser)');

  useEffect(() => {
    if (open) setTab(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="panel" role="dialog" aria-modal="true" aria-label="연결 설정">
        <header className="panel-head">
          <h2>connection</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'daemon'} className={tab === 'daemon' ? 'on' : ''} onClick={() => setTab('daemon')}>
            Damon daemon
          </button>
          <button type="button" role="tab" aria-selected={tab === 'openai'} className={tab === 'openai' ? 'on' : ''} onClick={() => setTab('openai')}>
            OpenAI 호환
          </button>
          <button type="button" role="tab" aria-selected={tab === 'demo'} className={tab === 'demo' ? 'on' : ''} onClick={() => setTab('demo')}>
            Demo
          </button>
        </div>

        {tab === 'daemon' ? (
          <div className="panel-body">
            <p className="panel-copy">
              <code className="md-code mono">damond</code>가 떠 있으면 <code className="md-code mono">/health</code>를 확인하고 <code className="md-code mono">/v1/ws_ticket</code> →{' '}
              <code className="md-code mono">/ws</code>로 붙습니다. 기본 바인드는 <code className="md-code mono">127.0.0.1:9470</code>입니다.
            </p>
            <label className="field">
              <span className="field-label">daemon url</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:9470"
                className="mono"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">master auth token (선택)</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="loopback에서는 비워두세요"
                className="mono"
                type="password"
                spellCheck={false}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="primary-btn"
                onClick={() => onConnect('daemon', baseUrl, { masterToken: token || undefined, deviceToken: deviceToken || undefined })}
              >
                데몬에 연결
              </button>
              <button
                type="button"
                className="ghost-btn tall"
                onClick={() => onConnect('daemon', '/dm', { masterToken: token || undefined, deviceToken: deviceToken || undefined })}
                title="vite dev/preview의 /dm 프록시로 같은 오리진에서 붙습니다"
              >
                로컬 프록시 /dm
              </button>
            </div>
            <p className="panel-note">
              데몬은 CORS 헤더를 보내지 않습니다. 다른 오리진(GitHub Pages 등)의 페이지는 브라우저가 fetch를 막으므로, 이 저장소의{' '}
              <code className="md-code mono">npm run dev</code>가 여는 <code className="md-code mono">/dm</code> 프록시로 붙이세요.
            </p>

            <div className="divider">
              <span className="mono">or pair this browser</span>
            </div>
            <p className="panel-copy">
              다른 기기의 데몬은 페어링이 필요합니다. 데몬 설정의 <code className="md-code mono">device.pairing_key</code>로 8자리 키를 확인한 뒤,
              신뢰하는 화면에서 <code className="md-code mono">device.approve</code>로 승인하세요.
            </p>
            <div className="pair-row">
              <input
                value={pairingKey}
                onChange={(event) => setPairingKey(event.target.value)}
                placeholder="pairing key"
                className="mono"
                maxLength={12}
                spellCheck={false}
              />
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="device name"
                spellCheck={false}
              />
              <button type="button" className="ghost-btn" onClick={() => onPair(pairingKey, deviceName)} disabled={state.pairing.busy}>
                {state.pairing.busy ? 'pairing…' : 'pair'}
              </button>
            </div>
            {state.pairing.deviceId ? (
              <div className="pair-status mono">
                <span>device {state.pairing.deviceId.slice(0, 10)}</span>
                <span className={`pill ${state.pairing.status === 'approved' ? 'ok' : 'pending'}`}>{state.pairing.status}</span>
                <button type="button" className="ghost-btn" onClick={onCheckPairing}>
                  check
                </button>
              </div>
            ) : null}
            {state.pairing.error ? <p className="panel-error">{state.pairing.error}</p> : null}

            <label className="field">
              <span className="field-label">device token (승인 후)</span>
              <input
                value={deviceToken}
                onChange={(event) => setDeviceToken(event.target.value)}
                placeholder="승인된 기기의 토큰"
                className="mono"
                type="password"
                spellCheck={false}
              />
            </label>
          </div>
        ) : null}

        {tab === 'openai' ? (
          <div className="panel-body">
            <p className="panel-copy">
              OpenAI 호환 <code className="md-code mono">/v1/models</code>와 <code className="md-code mono">/v1/chat/completions</code> (SSE)를 말하는 서버라면 붙습니다 — LM Studio,
              llama.cpp, LiteLLM, 게이트웨이 등. 이 모드에서는 세션·메모리가 브라우저에 남습니다.
            </p>
            <label className="field">
              <span className="field-label">base url</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://127.0.0.1:1234"
                className="mono"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">api key (선택)</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="로컬 서버는 비워두세요"
                className="mono"
                type="password"
                spellCheck={false}
              />
            </label>
            <button type="button" className="primary-btn" onClick={() => onConnect('openai', baseUrl, { masterToken: token || undefined })}>
              연결
            </button>
          </div>
        ) : null}

        {tab === 'demo' ? (
          <div className="panel-body">
            <p className="panel-copy">
              시뮬레이션된 데몬입니다. 네트워크도 키도 쓰지 않고, 라우팅·비교 모드·메모리 주입이 모두 동작합니다. GitHub Pages 방문자가 바로 볼 수 있는
              경로입니다.
            </p>
            <ul className="panel-list">
              <li>4개 프로바이더 라우트 (Claude Code · Codex CLI · Qwen Code · OpenCode)</li>
              <li>같은 이벤트 스키마 — UI에 데모 분기가 없습니다</li>
              <li>대화는 localStorage에 남습니다</li>
            </ul>
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                onDemo();
                onClose();
              }}
            >
              데모 모드 사용
            </button>
          </div>
        ) : null}

        <footer className="panel-foot mono">
          <span>/health · /v1/ws_ticket · /ws (JSON-RPC v2)</span>
        </footer>
      </div>
    </div>
  );
}
