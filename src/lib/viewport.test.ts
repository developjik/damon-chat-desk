import { describe, expect, it } from 'vitest';
import { applyViewport, KEYBOARD_THRESHOLD, measureViewport } from './viewport';

function root() {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  return {
    props,
    classes,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
    },
    classList: {
      toggle: (name: string, force?: boolean) => void (force ? classes.add(name) : classes.delete(name)),
    },
  };
}

describe('measureViewport', () => {
  it('reports the visible box and no keyboard when it fills the window', () => {
    expect(measureViewport({ height: 844, offsetTop: 0 }, 844)).toEqual({ height: 844, offsetTop: 0, keyboard: false });
  });

  it('flags a keyboard when the visible box shrinks past the threshold', () => {
    expect(measureViewport({ height: 508.4, offsetTop: 279.6 }, 844)).toEqual({ height: 508, offsetTop: 280, keyboard: true });
    expect(measureViewport({ height: 844 - KEYBOARD_THRESHOLD, offsetTop: 0 }, 844)?.keyboard).toBe(false);
  });

  it('ignores pinch-zoom, missing API and bogus values', () => {
    expect(measureViewport({ height: 400, offsetTop: 10, scale: 2 }, 844)).toBeNull();
    expect(measureViewport(null, 844)).toBeNull();
    expect(measureViewport({ height: 0, offsetTop: 0 }, 844)).toBeNull();
    expect(measureViewport({ height: 600, offsetTop: -5 }, 844)?.offsetTop).toBe(0);
  });
});

describe('applyViewport', () => {
  it('writes the CSS vars and keyboard class, and clears them', () => {
    const el = root();
    applyViewport(el, { height: 508, offsetTop: 280, keyboard: true });
    expect(el.props.get('--vv-height')).toBe('508px');
    expect(el.props.get('--vv-top')).toBe('280px');
    expect(el.classes.has('keyboard-open')).toBe(true);
    applyViewport(el, null);
    expect(el.props.size).toBe(0);
    expect(el.classes.has('keyboard-open')).toBe(false);
  });
});
