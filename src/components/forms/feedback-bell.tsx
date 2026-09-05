'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquareWarning } from 'lucide-react';

/**
 * Topbar bell for the developer: a live badge of NEW (untriaged) feedback reports,
 * so you see them the moment you log in. Clicking opens the Feedback inbox. Re-checks
 * on window focus. Reuses the approvals bell's styling (wf-bell*).
 */
export function FeedbackBell() {
  const [count, setCount] = useState<number | null>(null);

  const load = () =>
    fetch('/api/feedback/count')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.count === 'number') setCount(d.count);
      })
      .catch(() => {});

  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  return (
    <div className="wf-bell">
      <Link href="/feedback" className="wf-bell-btn" title="New feedback & issues" aria-label="Feedback and issues">
        <MessageSquareWarning size={18} />
        {count ? <span className="wf-bell-badge">{count > 99 ? '99+' : count}</span> : null}
      </Link>
    </div>
  );
}
