// Confirm-before-delete. Every deletion in the app asks through here, so the person always gets
// the same unmistakable on-screen dialog (ConfirmHost, mounted in the root layout) before
// anything is removed. Plain module: client components import it.

export type ConfirmRequest = {
  /** What is about to happen, as a question: "Delete TMP-0051?" */
  title: string;
  /** What goes, and whether it can be undone. */
  body?: string;
  /** The destructive button's label. */
  confirmLabel?: string;
};

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

/**
 * Show the delete confirmation and wait for the answer: true only when the person presses the
 * confirm button. Cancel, Escape, clicking outside, or no dialog host on the page all mean no.
 */
export function confirmDelete(req: ConfirmRequest): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const detail: Pending = { ...req, resolve };
    const handled = !window.dispatchEvent(new CustomEvent('sd-confirm', { detail, cancelable: true }));
    // The host cancels the event to say it took the request; nobody listening = refuse.
    if (!handled) resolve(false);
  });
}
