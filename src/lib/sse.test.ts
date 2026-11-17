import { describe, expect, it } from 'vitest';
import { SSEParser, framesOf } from './sse';

describe('SSEParser', () => {
  it('emits one frame per blank line', () => {
    const parser = new SSEParser();
    const frames = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(frames.map((frame) => frame.data)).toEqual(['{"a":1}', '{"a":2}']);
    expect(frames.every((frame) => frame.event === 'message')).toBe(true);
  });

  it('holds a frame that is split across chunks', () => {
    const parser = new SSEParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'message', data: '{"a":1}', id: undefined }]);
  });

  it('accepts CRLF separators', () => {
    const parser = new SSEParser();
    const frames = parser.push('event: ping\r\ndata: keepalive\r\n\r\n');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: 'ping', data: 'keepalive' });
  });

  it('joins multi-line data with a newline and skips comments', () => {
    const parser = new SSEParser();
    const frames = parser.push(': keep-alive\ndata: line one\ndata: line two\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('line one\nline two');
  });

  it('flushes a trailing frame with no blank line', () => {
    const parser = new SSEParser();
    parser.push('data: [DONE]');
    expect(parser.flush()).toEqual([{ event: 'message', data: '[DONE]', id: undefined }]);
    expect(parser.flush()).toEqual([]);
  });

  it('keeps the event name scoped to its own frame', () => {
    const parser = new SSEParser();
    const frames = parser.push('event: delta\ndata: one\n\ndata: two\n\n');
    expect(frames.map((frame) => frame.event)).toEqual(['delta', 'message']);
  });
});

describe('framesOf', () => {
  it('frames an async iterable with arbitrary chunking', async () => {
    async function* chunks() {
      yield 'data: a';
      yield 'bc\n';
      yield '\ndata: def\n\n';
    }
    const out: string[] = [];
    for await (const frame of framesOf(chunks())) out.push(frame.data);
    expect(out).toEqual(['abc', 'def']);
  });
});
