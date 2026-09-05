'use client';

import { useRouter } from 'next/navigation';
import { MessageSquarePlus } from 'lucide-react';

/**
 * Floating "Report an issue" button shown on every page (mounted in FormLayout).
 * One click opens the Feedback page's compose form, carrying the page you were on
 * so the developer knows exactly where the problem is.
 */
export function ReportButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="fb-fab"
      title="Report a bug, suggest an improvement, or ask a question"
      onClick={() => {
        const from = typeof window !== 'undefined' ? window.location.pathname : '';
        router.push(`/feedback?compose=1&from=${encodeURIComponent(from)}`);
      }}
    >
      <MessageSquarePlus size={16} />
      <span>Report / Suggest</span>
    </button>
  );
}
