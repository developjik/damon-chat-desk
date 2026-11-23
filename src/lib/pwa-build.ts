/**
 * Build-time half of the PWA: emits `sw.js` from `src/sw.ts` and writes
 * the shell's file list and content hash into it, so every deploy that
 * changes a byte of the shell ships a byte-different worker — which is
 * what makes the browser notice an update.
 */

import type { Plugin } from 'vite';
import type { ShellManifest } from './sw';

export const SW_FILE = 'sw.js';
export const SW_PLACEHOLDER = '__SHELL_MANIFEST__';

/**
 * `public/` files the shell needs offline. Vite copies them verbatim and
 * they are not in the bundle, so they are listed here (a test checks the
 * manifest's icons against it).
 */
export const PUBLIC_SHELL_FILES = [
  'manifest.webmanifest',
  'icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

export interface BuiltFile {
  fileName: string;
  content: string | Uint8Array;
}

/** FNV-1a, 32-bit — a cache key, not a security boundary. */
export function hashContent(parts: Array<string | Uint8Array>): string {
  let hash = 0x811c9dc5;
  const encoder = new TextEncoder();
  for (const part of parts) {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * What gets precached: every built file except the worker and source maps.
 * `publicBytes` are the `public/` files' contents, so a deploy that only
 * changes an icon or the web manifest still ships a new worker.
 */
export function shellManifest(
  built: BuiltFile[],
  publicFiles: string[] = PUBLIC_SHELL_FILES,
  publicBytes: BuiltFile[] = [],
): ShellManifest {
  const shell = built
    .filter((file) => file.fileName !== SW_FILE && !file.fileName.endsWith('.map'))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const files = [...new Set([...shell.map((file) => file.fileName), ...publicFiles])].sort();
  const hashed = [...shell, ...publicBytes].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const version = hashContent([...files, ...hashed.flatMap((file) => [file.fileName, file.content])]);
  return { version, files };
}

/** Node's fs, typed locally: this project carries no @types/node. */
type ReadFile = (path: string) => Promise<Uint8Array>;

async function readPublic(publicDir: string, files: string[]): Promise<BuiltFile[]> {
  const fs = (await import('node:fs/promises' as string)) as { readFile: ReadFile };
  return Promise.all(files.map(async (fileName) => ({ fileName, content: await fs.readFile(`${publicDir}/${fileName}`) })));
}

export function shellPlugin(): Plugin {
  let root = '';
  let publicDir = '';
  return {
    name: 'damon-desk-shell',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    buildStart() {
      this.emitFile({ type: 'chunk', id: `${root}/src/sw.ts`, fileName: SW_FILE });
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const worker = bundle[SW_FILE];
        if (!worker || worker.type !== 'chunk') return this.error(`${SW_FILE} was not emitted`);
        // Registered as a classic script: it must not import anything.
        if (worker.imports.length > 0 || worker.dynamicImports.length > 0) {
          return this.error(`${SW_FILE} must be self-contained, but imports ${[...worker.imports, ...worker.dynamicImports].join(', ')}`);
        }
        const built: BuiltFile[] = Object.values(bundle).map((file) => ({
          fileName: file.fileName,
          content: file.type === 'chunk' ? file.code : file.source,
        }));
        const manifest = shellManifest(built, PUBLIC_SHELL_FILES, await readPublic(publicDir, PUBLIC_SHELL_FILES));
        if (!worker.code.includes(SW_PLACEHOLDER)) return this.error(`${SW_FILE} lost its ${SW_PLACEHOLDER} placeholder`);
        worker.code = worker.code.split(SW_PLACEHOLDER).join(JSON.stringify(manifest));
      },
    },
  };
}
