'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';

// Topbar bell with a live badge of items awaiting approval. Re-checks on window
// focus so an approver returning to the tab sees the current count.
export function ApprovalsBell() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/approvals/count')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d && typeof d.count === 'number') setCount(d.count); })
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('focus', load); };
  }, []);

  const n = count ?? 0;
  return (
    <a
      href="/approvals"
      title={n > 0 ? `${n} awaiting approval` : 'Approvals'}
      aria-label={`${n} items awaiting approval`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', color: 'inherit' }}
    >
      <Bell size={18} />
      {n > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: -8,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 8,
            background: '#c5221f',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            textAlign: 'center',
          }}
        >
          {n > 99 ? '99+' : n}
        </span>
      )}
    </a>
  );
}
