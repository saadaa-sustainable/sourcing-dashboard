'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, Inbox } from 'lucide-react';
import type { ApprovalNotification } from '@/lib/forms/types';

const when = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  const diff = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

// Topbar bell: a live badge of items awaiting approval that opens a dropdown of
// those items. Clicking an item (not the bell) navigates to where it's actioned.
// Re-checks the count on window focus so a returning approver sees it fresh.
export function ApprovalsBell() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ApprovalNotification[] | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadCount = () =>
    fetch('/api/approvals/count')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.count === 'number') setCount(d.count); })
      .catch(() => {});

  useEffect(() => {
    loadCount();
    window.addEventListener('focus', loadCount);
    return () => window.removeEventListener('focus', loadCount);
  }, []);

  // Fetch the list on demand — called from the toggle when the panel opens, so
  // it reflects the latest queue (and we never setState synchronously in an effect).
  const loadList = () => {
    setLoading(true);
    fetch('/api/approvals/list')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (d?.items ?? []) as ApprovalNotification[];
        setItems(list);
        setCount(list.length);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) loadList();
      return next;
    });
  };

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const n = count ?? 0;

  return (
    <div className="wf-bell" ref={ref}>
      <button
        type="button"
        className="wf-bell-btn"
        onClick={toggle}
        title={n > 0 ? `${n} awaiting approval` : 'Approvals'}
        aria-label={`${n} items awaiting approval`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Bell size={18} />
        {n > 0 && <span className="wf-bell-badge">{n > 99 ? '99+' : n}</span>}
      </button>

      {open && (
        <div className="wf-bell-panel" role="menu">
          <div className="wf-bell-head">
            <strong>Notifications</strong>
            {n > 0 && <span className="wf-subtle">{n} awaiting approval</span>}
          </div>

          <div className="wf-bell-list">
            {loading && !items ? (
              <p className="wf-bell-empty">Loading…</p>
            ) : items && items.length > 0 ? (
              items.map((it) => (
                <Link
                  key={it.key}
                  href={it.href}
                  className="wf-bell-item"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  <span className="wf-bell-item-label">{it.label}</span>
                  <span className="wf-bell-item-sub">{it.sublabel}</span>
                  <span className="wf-bell-item-meta">
                    {it.submittedBy ? `from ${it.submittedBy}` : ''}
                    {it.submittedAt ? ` · ${when(it.submittedAt)}` : ''}
                  </span>
                </Link>
              ))
            ) : (
              <div className="wf-bell-empty">
                <Inbox size={22} strokeWidth={1.6} />
                <p>Nothing awaiting your approval.</p>
              </div>
            )}
          </div>

          <Link href="/approvals" className="wf-bell-foot" onClick={() => setOpen(false)}>
            Open the Approvals queue →
          </Link>
        </div>
      )}
    </div>
  );
}
