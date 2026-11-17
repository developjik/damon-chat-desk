/**
 * Browser file/clipboard side of the export. Kept out of the builders so
 * the export content stays testable in node.
 */

import type { ExportPayload } from './export';

/** Hand a generated file to the browser's download path. */
export function downloadPayload(payload: ExportPayload): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([payload.content], { type: payload.mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = payload.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Clipboard write with the execCommand fallback for non-secure origins. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the textarea path */
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
