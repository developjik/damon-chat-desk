import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, inline, tokenize } from './Markdown';
import { DEMO_ROUTES, composeReply } from '../lib/demo';

describe('tokenize', () => {
  it('separates fenced code, headings, lists and paragraphs', () => {
    const tokens = tokenize('## 제목\n\n문단 하나\n이어지는 줄\n\n- 항목\n- 항목2\n\n```ts\ncode()\n```');
    expect(tokens.map((token) => token.kind)).toEqual(['heading', 'paragraph', 'list', 'code']);
    expect(tokens[1].lines[0]).toBe('문단 하나\n이어지는 줄');
    expect(tokens[3].lines).toEqual(['code()']);
  });

  it('keeps an unclosed fence inside the code block until EOF', () => {
    const tokens = tokenize('```\nstill code');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].lines).toEqual(['still code']);
  });

  it('does not loop on bold lines that follow a paragraph', () => {
    const tokens = tokenize('첫 문단\n**굵은 줄** — 설명\n\n둘째 문단');
    expect(tokens).toHaveLength(2);
    expect(tokens[1].lines[0]).toBe('둘째 문단');
  });
});

describe('inline', () => {
  it('returns without looping on nested bold, italic, code and links', () => {
    const nodes = inline('**굵게** 그리고 *기울임*, `code`, [링크](https://example.com) 끝');
    expect(nodes.length).toBeGreaterThan(3);
  });

  it('refuses a javascript: link target', () => {
    const markup = renderToStaticMarkup(<Markdown source={'[x](javascript:alert(1))'} />);
    expect(markup).not.toContain('href="javascript');
  });
});

describe('Markdown render', () => {
  it('renders every demo reply without hanging', () => {
    for (const target of DEMO_ROUTES) {
      const markup = renderToStaticMarkup(<Markdown source={composeReply('스트리밍과 배치 중 뭐가 나아?', target)} />);
      expect(markup.length).toBeGreaterThan(100);
    }
  });

  it('renders the code fence with its language', () => {
    const markup = renderToStaticMarkup(<Markdown source={'```ts\nconst a = 1;\n```'} />);
    expect(markup).toContain('code-block');
    expect(markup).toContain('ts');
    expect(markup).toContain('const a = 1;');
  });

  it('marks a streaming reply with a caret', () => {
    const markup = renderToStaticMarkup(<Markdown source={'진행 중'} streaming />);
    expect(markup).toContain('caret');
  });
});
