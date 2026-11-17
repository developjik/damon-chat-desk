import { useEffect, useRef, useState } from 'react';
import { formatMs, formatTokens, firstTokenMs, groupTargets, tokensPerSecond, usageSummary } from '../lib/targets';
import type { ReplySlot, RouteTarget } from '../lib/types';

interface RoutePickerProps {
  targets: RouteTarget[];
  value: string | null;
  onChange: (key: string) => void;
  label?: string;
  disabled?: boolean;
  disabledKey?: string | null;
  align?: 'left' | 'right';
}

export function RoutePicker({ targets, value, onChange, label, disabled, disabledKey, align = 'left' }: RoutePickerProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const selected = targets.find((target) => target.key === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = groupTargets(targets);

  return (
    <div className={`route-picker ${align === 'right' ? 'right' : ''}`} ref={root}>
      {label ? <span className="field-label">{label}</span> : null}
      <button
        type="button"
        className="route-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`dot ${selected?.available === false ? 'muted' : 'ok'}`} aria-hidden />
        {selected ? (
          <>
            <span className="route-provider">{selected.providerLabel}</span>
            <span className="sep" aria-hidden>
              /
            </span>
            <span className="route-model mono">{selected.model || 'default'}</span>
          </>
        ) : (
          <span className="route-model">모델 선택</span>
        )}
        <span className="chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="route-menu" role="listbox">
          {groups.map((group) => (
            <div className="route-group" key={group.provider}>
              <div className="route-group-head mono">{group.label}</div>
              {group.targets.map((target) => {
                const isCurrent = target.key === value;
                const isBlocked = !!disabledKey && target.key === disabledKey;
                return (
                  <button
                    key={target.key}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className={`route-option ${isCurrent ? 'selected' : ''}`}
                    disabled={isBlocked}
                    onClick={() => {
                      onChange(target.key);
                      setOpen(false);
                    }}
                  >
                    <span className="route-option-name">{target.modelLabel || target.model || 'default model'}</span>
                    {target.model && target.modelLabel !== target.model ? (
                      <span className="route-option-model mono">{target.model}</span>
                    ) : null}
                    {isCurrent ? <span className="check" aria-hidden>✓</span> : null}
                    {isBlocked ? <span className="faint mono tiny">used</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {targets.length === 0 ? <div className="route-empty">연결된 프로바이더가 없습니다</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function SlotMetrics({ slot, now }: { slot: ReplySlot; now?: number }) {
  const tokens = slot.usage?.outputTokens ?? (slot.text ? Math.round(slot.text.length / 3.2) : undefined);
  if (slot.imported) {
    return (
      <div className="slot-metrics mono">
        <span>daemon history</span>
        {tokens !== undefined ? (
          <span>
            <b>{formatTokens(tokens)}</b> tok
          </span>
        ) : null}
      </div>
    );
  }
  const ttft = firstTokenMs(slot);
  const streamWindow = (slot.endedAt ?? now ?? Date.now()) - (slot.firstTokenAt ?? slot.startedAt);
  const tps = slot.status === 'streaming' ? tokensPerSecond(tokens, streamWindow) : undefined;
  const elapsed = (slot.endedAt ?? now ?? Date.now()) - slot.startedAt;

  return (
    <div className="slot-metrics mono">
      {ttft !== undefined ? (
        <span title="time to first token">
          ttft <b>{formatMs(ttft)}</b>
        </span>
      ) : null}
      <span title="wall clock">
        <b>{formatMs(elapsed)}</b>
      </span>
      {tokens !== undefined ? (
        <span title="output tokens">
          <b>{formatTokens(tokens)}</b> tok
          {tps ? <em> · {tps.toFixed(0)}/s</em> : null}
        </span>
      ) : null}
      {usageSummary(slot.usage, { omitOutput: tokens !== undefined }).map((part) => (
        <span key={part}>{part}</span>
      ))}
    </div>
  );
}
