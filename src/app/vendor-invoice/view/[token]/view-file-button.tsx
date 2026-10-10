'use client';

import { useState } from 'react';
import { signVendorViewFile } from '@/lib/forms/actions';

/** Opens one of the vendor's own PDFs through a short-lived signed URL. */
export function ViewFileButton({ token, id }: { token: string; id: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setErr(null);
    try {
      const res = await signVendorViewFile(token, id);
      if ('url' in res) window.open(res.url, '_blank', 'noopener,noreferrer');
      else setErr(res.error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="vi-link-btn" disabled={busy} onClick={open} title={err ?? undefined}>
      {busy ? '…' : err ? 'Retry' : 'View'}
    </button>
  );
}
