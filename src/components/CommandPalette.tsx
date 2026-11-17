import { useEffect, useMemo, useRef, useState } from 'react';
import type { DeskState } from '../lib/desk';
import {
  GROUP_LABELS,
  buildCommands,
  filterCommands,
  nextEnabledIndex,
  type PaletteCommand,
  type PaletteHandlers,
} from '../lib/commands';

interface CommandPaletteProps {
  open: boolean;
  state: DeskState;
  handlers: PaletteHandlers;
  onClose: () => void;
}

const optionId = (command: PaletteCommand): string => `palette-opt-${command.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/**
 * `Cmd/Ctrl+K` — one 1px-bordered list over everything the desk can do.
 * Arrow keys move (disabled rows are skipped), Enter runs, Esc closes.
 */
export function CommandPalette({ open, state, handlers, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const commands = useMemo(() => buildCommands(state, handlers), [state, handlers]);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeIndex = results.length === 0 ? -1 : Math.min(Math.max(cursor, 0), results.length - 1);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // The overlay mounts in this commit; focus after the browser paints it.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Esc closes from anywhere in the sheet — a click on a row or the
  // header button can leave focus outside the input.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector('[aria-selected="true"]');
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, results.length]);

  if (!open) return null;

  const runAt = (index: number) => {
    const command = results[index];
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor(nextEnabledIndex(results, activeIndex, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor(nextEnabledIndex(results, activeIndex, -1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runAt(activeIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="overlay palette-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="커맨드 팔레트">
        <div className="palette-search">
          <span className="palette-key mono" aria-hidden>
            ⌘K
          </span>
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="명령 · 세션 · 라우트 검색"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="palette-list"
            aria-activedescendant={activeIndex >= 0 ? optionId(results[activeIndex]) : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="palette-count mono">{results.length}</span>
        </div>

        <ul className="palette-list" id="palette-list" role="listbox" aria-label="명령" ref={listRef}>
          {results.length === 0 ? (
            <li className="palette-empty">일치하는 명령이 없습니다</li>
          ) : (
            results.map((command, index) => {
              const previous = index > 0 ? results[index - 1] : null;
              const heading = !previous || previous.group !== command.group ? GROUP_LABELS[command.group] : null;
              return (
                <li key={command.id} className="palette-row" role="presentation">
                  {heading ? (
                    <div className="palette-group mono" role="presentation">
                      {heading}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={optionId(command)}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="palette-item"
                    disabled={command.disabled}
                    onMouseMove={() => index !== activeIndex && setCursor(index)}
                    onClick={() => runAt(index)}
                  >
                    <span className="palette-item-label">{command.label}</span>
                    {command.detail ? <span className="palette-item-detail mono">{command.detail}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <footer className="palette-foot mono">
          <span>↑↓ 이동</span>
          <span>↵ 실행</span>
          <span>esc 닫기</span>
        </footer>
      </div>
    </div>
  );
}
