import { useEffect, useRef, useState } from 'react';
import type { RouteTarget } from '../lib/types';
import { RoutePicker } from './RoutePicker';

/** The unsent draft survives a reload (e.g. accepting a shell update). */
const DRAFT_KEY = 'damon-desk.draft';

function readDraft(): string {
  try {
    return globalThis.sessionStorage?.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(value: string): void {
  try {
    if (value) globalThis.sessionStorage?.setItem(DRAFT_KEY, value);
    else globalThis.sessionStorage?.removeItem(DRAFT_KEY);
  } catch {
    /* storage blocked: the draft just stays in memory */
  }
}

interface ComposerProps {
  targets: RouteTarget[];
  primaryKey: string | null;
  secondaryKey: string | null;
  compare: boolean;
  busy: boolean;
  memoryEnabled: boolean;
  memoryCount: number;
  onSend: (prompt: string) => void;
  /** While a reply streams, the composer sends `turn.steer` instead. */
  onSteer: (text: string) => void;
  onPrimary: (key: string) => void;
  onSecondary: (key: string) => void;
  onCompare: (compare: boolean) => void;
  onMemory: (enabled: boolean) => void;
  placeholder?: string;
}

export function Composer({
  targets,
  primaryKey,
  secondaryKey,
  compare,
  busy,
  memoryEnabled,
  memoryCount,
  onSend,
  onSteer,
  onPrimary,
  onSecondary,
  onCompare,
  onMemory,
  placeholder,
}: ComposerProps) {
  const [value, setValue] = useState(readDraft);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => writeDraft(value), [value]);

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(220, node.scrollHeight)}px`;
  }, [value]);

  const submit = () => {
    const prompt = value.trim();
    if (!prompt) return;
    if (busy) {
      onSteer(prompt);
      setValue('');
      return;
    }
    if (targets.length === 0) return;
    onSend(prompt);
    setValue('');
  };

  const canSend = value.trim().length > 0 && targets.length > 0;

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={area}
          value={value}
          rows={1}
          placeholder={
            busy
              ? '스트리밍 중 — 방향 수정을 보내면 turn.steer로 전달됩니다 (Enter)'
              : (placeholder ?? '메시지를 입력하세요 — Enter로 전송, Shift+Enter로 줄바꿈')
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
        />
        <div className="composer-bar">
          <div className="composer-routes">
            <RoutePicker targets={targets} value={primaryKey} onChange={onPrimary} label={compare ? 'A' : 'route'} />
            {compare ? (
              <RoutePicker
                targets={targets}
                value={secondaryKey}
                onChange={onSecondary}
                label="B"
                disabledKey={primaryKey}
              />
            ) : null}
            <button
              type="button"
              className={`chip ${compare ? 'on' : ''}`}
              onClick={() => onCompare(!compare)}
              title="같은 프롬프트를 두 프로바이더로 동시 전송"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="1" y="2" width="4" height="8" rx="1" />
                <rect x="7" y="2" width="4" height="8" rx="1" />
              </svg>
              split
            </button>
            <button
              type="button"
              className={`chip ${memoryEnabled ? 'on' : ''}`}
              onClick={() => onMemory(!memoryEnabled)}
              title="저장된 메모리를 프롬프트 앞에 붙입니다"
            >
              memory
              <span className="chip-count mono">{memoryEnabled ? memoryCount : 0}</span>
            </button>
          </div>
          <div className="composer-send">
            <span className="hint mono">{busy ? 'steer' : '⏎'}</span>
            <button type="button" className={`send-btn ${busy ? 'steer' : ''}`} onClick={submit} disabled={!canSend}>
              {busy ? 'steer' : 'send'}
            </button>
          </div>
        </div>
      </div>
      <div className="composer-foot mono">
        <span>
          {busy
            ? 'steering the live turn — this text does not open a new turn'
            : compare
              ? 'split mode — both routes receive the same prompt'
              : 'single route'}
        </span>
        <span className="faint">session &amp; memory live on the daemon · UI is a renderer</span>
      </div>
    </div>
  );
}
