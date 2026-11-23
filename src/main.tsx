import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DeskController } from './lib/desk';
import { registerShell, ShellStatus, watchNetwork } from './lib/pwa';
import { trackViewport } from './lib/viewport';
import './styles.css';

const desk = new DeskController();
void desk.init();

const shell = new ShellStatus(navigator.onLine);
watchNetwork(window, shell, () => void desk.retryConnection());
trackViewport(window, document.documentElement);
// Dev serves modules from Vite; only a build has a shell to cache.
if (import.meta.env.PROD) registerShell(shell, import.meta.env.BASE_URL);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App desk={desk} shell={shell} />
    </StrictMode>,
  );
}

// expose for e2e smoke checks (Playwright reads the store, not the DOM)
declare global {
  interface Window {
    __damonDesk?: DeskController;
  }
}
window.__damonDesk = desk;
