// Lightweight toast helper (no dependency). Two entry points:
//  - flashToast(): stash a message that shows AFTER a full reload (the common
//    save→window.location.reload() pattern would otherwise swallow it).
//  - emitToast(): show a toast immediately, for handlers that don't reload.
// ToastHost (mounted in the root layout) renders them.
export type ToastTone = 'success' | 'error' | 'info';
const KEY = 'sd_flash_toast';

export function flashToast(msg: string, tone: ToastTone = 'success') {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ msg, tone }));
  } catch {
    /* ignore */
  }
}

export function emitToast(msg: string, tone: ToastTone = 'success') {
  try {
    window.dispatchEvent(new CustomEvent('sd-toast', { detail: { msg, tone } }));
  } catch {
    /* ignore */
  }
}

/** Flash a success toast, then reload — drop-in for `window.location.reload()`. */
export function reloadWithToast(msg = 'Saved.') {
  flashToast(msg, 'success');
  window.location.reload();
}

export function takeFlashToast(): { msg: string; tone: ToastTone } | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (!v) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(v) as { msg: string; tone: ToastTone };
  } catch {
    return null;
  }
}
