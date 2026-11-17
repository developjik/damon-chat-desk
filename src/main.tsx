import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DeskController } from './lib/desk';
import './styles.css';

const desk = new DeskController();
void desk.init();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App desk={desk} />
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
