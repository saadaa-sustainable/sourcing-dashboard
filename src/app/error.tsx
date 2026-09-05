'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, MessageSquarePlus } from 'lucide-react';

/**
 * Route error boundary. When a page crashes the user gets a calm screen instead of a
 * blank one — and a one-click "Report this error" that pre-fills the Feedback form
 * with the technical details (message, digest, page), so the developer gets a usable
 * bug report without the user having to describe the crash.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface it in the console too, for anyone with devtools open.
    console.error('Page error:', error);
  }, [error]);

  function report() {
    const path = typeof window !== 'undefined' ? window.location.pathname : '';
    const detail = [
      `Something broke on: ${path}`,
      `Error: ${error?.message ?? 'unknown'}`,
      error?.digest ? `Ref: ${error.digest}` : '',
      '',
      'What I was doing when it happened: ',
    ].join('\n');
    const url =
      `/feedback?compose=1&kind=bug` +
      `&title=${encodeURIComponent(`Crash on ${path || 'a page'}`)}` +
      `&detail=${encodeURIComponent(detail)}` +
      `&from=${encodeURIComponent(path)}`;
    window.location.assign(url);
  }

  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div
        style={{
          maxWidth: 460,
          textAlign: 'center',
          background: '#fff',
          border: '1px solid #e7e2d2',
          borderRadius: 14,
          padding: 28,
          boxShadow: '0 6px 22px rgba(0,0,0,.06)',
        }}
      >
        <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, margin: '0 auto 14px', borderRadius: 12, background: '#fdecea', color: '#c0392b' }}>
          <AlertTriangle size={24} />
        </div>
        <h1 style={{ fontSize: 19, fontWeight: 800, margin: '0 0 6px' }}>Something went wrong on this page</h1>
        <p style={{ fontSize: 14, color: '#6b6559', margin: '0 0 18px' }}>
          It&rsquo;s not your fault. Try again, or send this to the developer in one click —
          the technical details are filled in for you.
        </p>
        {error?.digest && (
          <p style={{ fontSize: 11, color: '#8a8578', margin: '0 0 18px', fontFamily: 'monospace' }}>Ref: {error.digest}</p>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', fontSize: 13, fontWeight: 700, color: '#49443d', background: '#fff', border: '1px solid #d2c9b8', borderRadius: 9, cursor: 'pointer' }}
          >
            <RefreshCw size={14} /> Try again
          </button>
          <button
            type="button"
            onClick={report}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 15px', fontSize: 13, fontWeight: 700, color: '#2c2420', background: '#f0c61e', border: '1px solid #d9b313', borderRadius: 9, cursor: 'pointer' }}
          >
            <MessageSquarePlus size={14} /> Report this error
          </button>
        </div>
      </div>
    </div>
  );
}
