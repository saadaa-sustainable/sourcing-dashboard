// Client-only helpers for the feedback channel: shrink a screenshot to a small
// base64 data URL (so it fits in a table cell, no storage bucket needed), and
// capture the browser/page context that helps the developer reproduce a bug.

/** Resize + JPEG-compress an image File to a data URL (typically 50–250 KB). */
export async function compressImageToDataUrl(
  file: File,
  maxW = 1400,
  quality = 0.7,
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/** Auto-captured environment for a report — pasted into the feedback context. */
export function captureContext(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  return {
    url: window.location.href,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    screen: `${window.screen.width}×${window.screen.height}`,
    language: navigator.language,
    when: new Date().toISOString(),
  };
}
