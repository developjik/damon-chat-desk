import { installServiceWorker, type ShellManifest, type SwGlobal } from './lib/sw';

/** Replaced with the built file list by `shellPlugin` (src/lib/pwa-build.ts). */
declare const __SHELL_MANIFEST__: ShellManifest;

installServiceWorker(self as unknown as SwGlobal, __SHELL_MANIFEST__);
