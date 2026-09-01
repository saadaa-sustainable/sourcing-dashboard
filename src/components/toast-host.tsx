'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { takeFlashToast, type ToastTone } from '@/lib/toast';

type Toast = { id: number; msg: string; tone: ToastTone };
let counter = 0;

const TONE: Record<ToastTone, { bg: string; fg: string; Icon: typeof Info }> = {
  success: { bg: '#ecf1e9', fg: '#4f7c4d', Icon: CheckCircle2 },
  error: { bg: '#fdecea', fg: '#c0392b', Icon: AlertCircle },
  info: { bg: '#d6e1f5', fg: '#355c7a', Icon: Info },
};

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const add = (msg: string, tone: ToastTone) => {
      const id = ++counter;
      setToasts((t) => [...t, { id, msg, tone }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
    };
    const flash = takeFlashToast();
    if (flash) add(flash.msg, flash.tone);
    const onToast = (e: Event) => {
      const d = (e as CustomEvent).detail as { msg?: string; tone?: ToastTone } | undefined;
      if (d?.msg) add(d.msg, d.tone ?? 'success');
    };
    window.addEventListener('sd-toast', onToast);
    return () => window.removeEventListener('sd-toast', onToast);
  }, []);

  if (!mounted || !toasts.length) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => {
        const { bg, fg, Icon } = TONE[t.tone];
        return (
          <div
            key={t.id}
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: bg,
              color: fg,
              border: `1px solid ${fg}33`,
              borderRadius: 8,
              padding: '10px 12px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <Icon size={16} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{t.msg}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((s) => s.filter((x) => x.id !== t.id))}
              style={{ background: 'none', border: 'none', color: fg, cursor: 'pointer', display: 'flex' }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
