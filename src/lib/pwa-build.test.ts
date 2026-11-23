import { describe, expect, it } from 'vitest';
import manifestSource from '../../public/manifest.webmanifest?raw';
import indexHtml from '../../index.html?raw';
import { hashContent, PUBLIC_SHELL_FILES, shellManifest, SW_FILE } from './pwa-build';

describe('shellManifest', () => {
  const built = [
    { fileName: 'index.html', content: '<html>' },
    { fileName: 'assets/index-a.js', content: 'console.log(1)' },
    { fileName: 'assets/index-a.js.map', content: '{}' },
    { fileName: SW_FILE, content: 'worker' },
  ];

  it('lists built and public files, never the worker or source maps', () => {
    const manifest = shellManifest(built, ['icon.svg']);
    expect(manifest.files).toEqual(['assets/index-a.js', 'icon.svg', 'index.html']);
  });

  it('changes version when any shell byte changes, not when the worker does', () => {
    const base = shellManifest(built).version;
    expect(shellManifest(built).version).toBe(base);
    expect(shellManifest(built.map((f) => (f.fileName === 'index.html' ? { ...f, content: '<html lang=ko>' } : f))).version).not.toBe(base);
    expect(shellManifest(built.map((f) => (f.fileName === SW_FILE ? { ...f, content: 'other' } : f))).version).toBe(base);
    const icon = (byte: number) => [{ fileName: 'icons/icon-192.png', content: new Uint8Array([byte]) }];
    expect(shellManifest(built, undefined, icon(1)).version).toBe(shellManifest(built, undefined, icon(1)).version);
    expect(shellManifest(built, undefined, icon(1)).version).not.toBe(shellManifest(built, undefined, icon(2)).version);
  });

  it('hashes bytes and strings alike', () => {
    expect(hashContent(['ab'])).toBe(hashContent([new TextEncoder().encode('ab')]));
    expect(hashContent(['a', 'b'])).not.toBe(hashContent(['ab']));
    expect(hashContent([])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(manifestSource) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string; purpose?: string; type: string }>;
  };

  it('is installable: name, standalone, relative start_url and scope', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    // Relative so the same file works at / and at /damon-chat-desk/.
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('has 192 and 512 icons and a maskable one, all precached', () => {
    const sizes = manifest.icons.filter((icon) => (icon.purpose ?? 'any').includes('any')).map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose?.includes('maskable'))).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(false);
      expect(PUBLIC_SHELL_FILES).toContain(icon.src);
    }
  });

  it('is linked from index.html with the iOS meta tags', () => {
    expect(indexHtml).toContain('rel="manifest" href="./manifest.webmanifest"');
    expect(indexHtml).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(indexHtml).toContain('rel="apple-touch-icon" href="./icons/apple-touch-icon.png"');
    expect(PUBLIC_SHELL_FILES).toContain('icons/apple-touch-icon.png');
    expect(indexHtml).toContain(`content="${manifest.theme_color}"`);
  });
});
