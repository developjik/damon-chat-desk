/**
 * Keep the composer above the on-screen keyboard.
 *
 * iOS Safari does not shrink the layout viewport (or `100dvh`) when the
 * keyboard opens; it pans the page instead, so a bottom-docked input
 * slides under the keyboard. `visualViewport` reports the part actually
 * visible — the desk sizes itself to that box (`--vv-height`, `--vv-top`).
 */

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  scale?: number;
}

export interface ViewportMetrics {
  height: number;
  offsetTop: number;
  /** The visible box is much shorter than the window: a keyboard is up. */
  keyboard: boolean;
}

/** Smaller than any on-screen keyboard, larger than a collapsing URL bar. */
export const KEYBOARD_THRESHOLD = 120;

export function measureViewport(viewport: VisualViewportLike | null | undefined, innerHeight: number): ViewportMetrics | null {
  if (!viewport || !(viewport.height > 0)) return null;
  // Pinch-zoom also shrinks the visual viewport; resizing the app then
  // would fight the zoom, so the layout keeps its own height.
  if ((viewport.scale ?? 1) > 1.01) return null;
  const height = Math.round(viewport.height);
  return {
    height,
    offsetTop: Math.max(0, Math.round(viewport.offsetTop)),
    keyboard: innerHeight - height > KEYBOARD_THRESHOLD,
  };
}

interface StyleTarget {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  classList: { toggle(name: string, force?: boolean): void };
}

export function applyViewport(root: StyleTarget, metrics: ViewportMetrics | null): void {
  if (!metrics) {
    root.style.removeProperty('--vv-height');
    root.style.removeProperty('--vv-top');
    root.classList.toggle('keyboard-open', false);
    return;
  }
  root.style.setProperty('--vv-height', `${metrics.height}px`);
  root.style.setProperty('--vv-top', `${metrics.offsetTop}px`);
  root.classList.toggle('keyboard-open', metrics.keyboard);
}

/** Wire `visualViewport` resize/scroll to the root element's CSS vars. */
export function trackViewport(win: Window, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => applyViewport(root, measureViewport(viewport, win.innerHeight)));
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}
