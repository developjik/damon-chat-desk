/**
 * Server-sent events parser (the wire format both `/v1/chat/completions`
 * and the daemon's SSE-shaped pushes use).
 *
 * Written as a pull parser so it can be unit-tested without a fetch:
 * feed arbitrary chunk boundaries (including a split UTF-8-free string
 * mid-field) and read complete frames back.
 */

export interface SSEFrame {
  event: string;
  data: string;
  id?: string;
}

export class SSEParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  /** Feed a decoded chunk; returns every frame the chunk completed. */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];
    // Frames are separated by a blank line; accept \n, \r\n and \r.
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = this.consume(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** End of stream: return a trailing frame with no blank line after it. */
  flush(): SSEFrame[] {
    const raw = this.buffer;
    this.buffer = '';
    const frame = raw ? this.consume(raw) : null;
    return frame ? [frame] : [];
  }

  private consume(raw: string): SSEFrame | null {
    const lines = raw.split(/\r\n|\n|\r/);
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue; // keep-alive comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      switch (field) {
        case 'event':
          this.event = value;
          break;
        case 'data':
          this.data.push(value);
          break;
        case 'id':
          this.id = value;
          break;
        default:
          break; // retry: and unknown fields are ignored
      }
    }
    if (this.data.length === 0) {
      this.event = '';
      return null;
    }
    const frame: SSEFrame = {
      event: this.event || 'message',
      data: this.data.join('\n'),
      id: this.id,
    };
    this.event = '';
    this.data = [];
    this.id = undefined;
    return frame;
  }
}

/** Parse an async iterable of decoded string chunks into frames. */
export async function* framesOf(chunks: AsyncIterable<string>): AsyncGenerator<SSEFrame> {
  const parser = new SSEParser();
  for await (const chunk of chunks) {
    for (const frame of parser.push(chunk)) yield frame;
  }
  for (const frame of parser.flush()) yield frame;
}

/** Decode a byte stream into text chunks (streaming, not buffered). */
export async function* decodeStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
