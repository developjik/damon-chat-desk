import { describe, expect, it } from 'vitest';
import { hostOf, isLoopbackHost, needsDemoFallback, resolveBasePath } from './hosting';

describe('resolveBasePath', () => {
  it('defaults to / and normalizes a project-page path', () => {
    expect(resolveBasePath(undefined)).toBe('/');
    expect(resolveBasePath('')).toBe('/');
    expect(resolveBasePath('/')).toBe('/');
    expect(resolveBasePath('damon-chat-desk')).toBe('/damon-chat-desk/');
    expect(resolveBasePath('/damon-chat-desk/')).toBe('/damon-chat-desk/');
    expect(resolveBasePath('  /a/b// ')).toBe('/a/b/');
  });
});

describe('loopback hosts', () => {
  it('reads IPv6 brackets as syntax, not part of the host', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('damon.example.dev')).toBe(false);
  });

  it('pulls the host out of a URL and leaves relative paths alone', () => {
    expect(hostOf('http://127.0.0.1:9470')).toBe('127.0.0.1');
    expect(hostOf('https://daemon.example.dev/base')).toBe('daemon.example.dev');
    expect(hostOf('/dm')).toBeNull();
  });
});

describe('needsDemoFallback', () => {
  const pages = { protocol: 'https:', hostname: 'developjik.github.io' };
  const dev = { protocol: 'http:', hostname: '127.0.0.1' };

  it('sends a public https page to the demo when its daemon is on loopback', () => {
    expect(needsDemoFallback('daemon', 'http://127.0.0.1:9470', pages)).toBe(true);
    expect(needsDemoFallback('openai', 'http://localhost:1234/v1', pages)).toBe(true);
  });

  it('leaves reachable targets and local dev to the probe', () => {
    expect(needsDemoFallback('daemon', 'https://daemon.example.dev', pages)).toBe(false);
    expect(needsDemoFallback('daemon', '/dm', pages)).toBe(false);
    expect(needsDemoFallback('daemon', 'http://127.0.0.1:9470', dev)).toBe(false);
    expect(needsDemoFallback('demo', 'demo://simulated', pages)).toBe(false);
    expect(needsDemoFallback('daemon', 'http://127.0.0.1:9470', null)).toBe(false);
  });
});
