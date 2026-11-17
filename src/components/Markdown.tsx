/**
 * A small, dependency-free Markdown renderer.
 *
 * Deliberately narrow: fenced code, headings, lists, quotes, rules and
 * inline code/bold/italic/links. Anything else renders as text — a
 * chat surface should never invent rich content the model did not send,
 * and building React nodes (not HTML strings) keeps injected markup
 * inert.
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react';

interface Token {
  kind: 'code' | 'heading' | 'list' | 'ordered' | 'quote' | 'rule' | 'paragraph';
  level?: number;
  lang?: string;
  lines: string[];
  ordered?: boolean;
}

export function tokenize(source: string): Token[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const tokens: Token[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence (or EOF)
      tokens.push({ kind: 'code', lang, lines: body });
      continue;
    }

    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      tokens.push({ kind: 'heading', level: heading[1].length, lines: [heading[2]] });
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      tokens.push({ kind: 'rule', lines: [] });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      tokens.push({ kind: 'quote', lines: body });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    if (bullet.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = bullet.exec(lines[index]);
        if (match) {
          body.push(match[1]);
          index += 1;
          continue;
        }
        // a wrapped continuation line
        if (body.length && /^\s{2,}\S/.test(lines[index])) {
          body[body.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: 'list', lines: body });
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/;
    if (ordered.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = ordered.exec(lines[index]);
        if (match) {
          body.push(match[1]);
          index += 1;
          continue;
        }
        if (body.length && /^\s{2,}\S/.test(lines[index])) {
          body[body.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: 'ordered', lines: body });
      continue;
    }

    const body: string[] = [];
    while (index < lines.length && !/^\s*$/.test(lines[index]) && !/^\s*```/.test(lines[index])) {
      // a heading/bullet right after a paragraph starts a new block
      if (body.length && /^(#{1,4}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(lines[index])) break;
      body.push(lines[index]);
      index += 1;
    }
    if (body.length) tokens.push({ kind: 'paragraph', lines: [body.join('\n')] });
    else index += 1;
  }

  return tokens;
}

/** Inline token grammar: code, bold, italic, link. */
const INLINE_SOURCE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/.source;

/**
 * Inline spans: code, bold, italic, links.
 *
 * The matcher is created per call on purpose. A module-level /g regex
 * shared by the recursive bold branch loses its `lastIndex` when the
 * inner call runs, and the outer loop then re-matches the same token
 * forever — an infinite render that takes the tab down with it.
 */
export function inline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const matcher = new RegExp(INLINE_SOURCE, 'g');
  let index = 0;
  while ((match = matcher.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const safe = /^https?:\/\//i.test(link[2]);
        nodes.push(
          safe ? (
            <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
              {link[1]}
            </a>
          ) : (
            <Fragment key={key}>{link[1]}</Fragment>
          ),
        );
      } else nodes.push(token);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="code-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => undefined,
            );
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const tokens = useMemo(() => tokenize(source), [source]);
  return (
    <div className="md">
      {tokens.map((token, index) => {
        const key = `t-${index}`;
        switch (token.kind) {
          case 'code':
            return <CodeBlock key={key} lang={token.lang} code={token.lines.join('\n')} />;
          case 'heading': {
            const Tag = (`h${Math.min(4, Math.max(2, (token.level ?? 2) + 1))}` as unknown) as 'h3';
            return <Tag key={key}>{inline(token.lines[0], key)}</Tag>;
          }
          case 'rule':
            return <hr key={key} />;
          case 'quote':
            return (
              <blockquote key={key}>
                {token.lines.map((line, i) => (
                  <p key={`${key}-${i}`}>{inline(line, `${key}-${i}`)}</p>
                ))}
              </blockquote>
            );
          case 'list':
          case 'ordered': {
            const ListTag = token.kind === 'list' ? 'ul' : 'ol';
            return (
              <ListTag key={key}>
                {token.lines.map((line, i) => (
                  <li key={`${key}-${i}`}>{inline(line, `${key}-${i}`)}</li>
                ))}
              </ListTag>
            );
          }
          default:
            return (
              <p key={key}>
                {token.lines[0].split('\n').map((line, i) => (
                  <Fragment key={`${key}-${i}`}>
                    {i > 0 ? <br /> : null}
                    {inline(line, `${key}-${i}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
      {streaming ? <span className="caret" aria-hidden /> : null}
    </div>
  );
}
