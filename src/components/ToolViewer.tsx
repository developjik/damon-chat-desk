import { useState } from 'react';
import { formatMs } from '../lib/targets';
import { TOOL_GLYPH, parseDiff, toolCounts, toolDuration } from '../lib/tools';
import type { ToolCall } from '../lib/types';

interface ToolViewerProps {
  calls: ToolCall[];
  now: number;
}

function StatusChip({ call }: { call: ToolCall }) {
  if (call.status === 'running') {
    return (
      <span className="tool-status running">
        <span className="pulse" aria-hidden />
        running
      </span>
    );
  }
  if (call.status === 'error') return <span className="tool-status error">failed</span>;
  return <span className="tool-status done">done</span>;
}

function Duration({ call, now }: { call: ToolCall; now: number }) {
  const ms = toolDuration(call, now);
  if (ms === undefined) return null;
  return <span className="tool-dur mono">{formatMs(ms)}</span>;
}

function Diff({ unified }: { unified: string }) {
  const lines = parseDiff(unified);
  return (
    <pre className="tool-diff mono">
      {lines.map((line, index) => (
        <span className={`diff-line ${line.kind}`} key={`${index}-${line.kind}`}>
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function ToolRow({ call, now }: { call: ToolCall; now: number }) {
  const result = call.result;
  return (
    <details className={`tool ${call.status}`}>
      <summary className="tool-head">
        <span className="tool-chevron" aria-hidden>
          ▸
        </span>
        <span className={`tool-glyph mono ${call.kind}`} aria-hidden>
          {TOOL_GLYPH[call.kind]}
        </span>
        <span className="tool-name mono">{call.name}</span>
        <span className="tool-label mono">{call.label}</span>
        <span className="tool-head-right">
          <Duration call={call} now={now} />
          <StatusChip call={call} />
        </span>
      </summary>
      <div className="tool-body">
        <div className="tool-section">
          <span className="tool-section-label mono">{call.kind === 'shell' ? 'command' : 'input'}</span>
          <pre className="tool-pre mono">{call.input ?? call.label}</pre>
        </div>
        {result?.stdout ? (
          <div className="tool-section">
            <span className="tool-section-label mono">stdout</span>
            <pre className="tool-pre mono">{result.stdout}</pre>
          </div>
        ) : null}
        {result?.stderr ? (
          <div className="tool-section">
            <span className="tool-section-label mono">stderr</span>
            <pre className="tool-pre mono err">{result.stderr}</pre>
          </div>
        ) : null}
        {result?.diff ? (
          <div className="tool-section">
            <span className="tool-section-label mono">diff</span>
            <Diff unified={result.diff} />
          </div>
        ) : null}
        {result?.error ? (
          <div className="tool-section">
            <span className="tool-section-label mono">error</span>
            <pre className="tool-pre mono err">{result.error}</pre>
          </div>
        ) : null}
        <div className="tool-meta mono">
          {typeof result?.exitCode === 'number' ? (
            <span className={result.exitCode === 0 ? 'ok' : 'err'}>exit {result.exitCode}</span>
          ) : null}
          {call.status === 'running' ? <span>in flight</span> : <Duration call={call} now={now} />}
          <span className="faint">{call.id}</span>
        </div>
      </div>
    </details>
  );
}

/**
 * The tool rail of one reply: one compact row per call, each opening to
 * its arguments and result. Closed rows keep the execution visible
 * without pushing the answer down the screen.
 */
export function ToolViewer({ calls, now }: ToolViewerProps) {
  const [open, setOpen] = useState(calls.length <= 4);
  if (calls.length === 0) return null;
  const counts = toolCounts(calls);
  const summary = [
    counts.running ? `${counts.running} running` : '',
    counts.done ? `${counts.done} done` : '',
    counts.error ? `${counts.error} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`tools ${open ? 'open' : ''}`}>
      <button type="button" className="tools-head" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="tools-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="tools-title mono">tools</span>
        <span className="tools-count mono">{calls.length}</span>
        <span className="tools-summary mono">{summary}</span>
      </button>
      {open ? (
        <div className="tools-list">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
