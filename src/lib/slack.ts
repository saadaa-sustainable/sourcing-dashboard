// Slack notifier for the feedback channel. Posts to a Slack Incoming Webhook whose
// URL lives ONLY in an env var (never hardcoded) — set SLACK_FEEDBACK_WEBHOOK_URL in
// Vercel to switch it on. Best-effort: if the var is unset or the POST fails, it
// silently no-ops so filing feedback is never blocked by Slack being down/unconfigured.
//
// Incoming webhooks send text/blocks only (no file upload), so screenshots are linked
// back to the dashboard rather than attached.

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://sourcing-dashboard-coral.vercel.app').replace(/\/$/, '');

type FeedbackNotice = {
  event: 'new' | 'reply';
  kind: string;
  severity?: string;
  title: string;
  body?: string | null;
  reporter?: string | null;
  pagePath?: string | null;
  relatedRef?: string | null;
  hasScreenshot?: boolean;
};

const KIND_EMOJI: Record<string, string> = { bug: '🐞', suggestion: '💡', question: '❓' };

export async function notifyFeedbackSlack(n: FeedbackNotice): Promise<void> {
  const url = process.env.SLACK_FEEDBACK_WEBHOOK_URL;
  if (!url) return; // not configured yet — no-op

  const emoji = KIND_EMOJI[n.kind] ?? '📝';
  const header = n.event === 'new' ? `${emoji} New ${n.kind}` : `${emoji} Reply on a ${n.kind}`;
  const lines = [
    `*${header}:* ${n.title}`,
    n.body ? `>${n.body.replace(/\n/g, '\n>').slice(0, 600)}` : '',
    [
      n.reporter ? `👤 ${n.reporter}` : '',
      n.severity ? `⚠️ ${n.severity}` : '',
      n.pagePath ? `📍 ${n.pagePath}` : '',
      n.relatedRef ? `🔖 ${n.relatedRef}` : '',
      n.hasScreenshot ? '🖼️ screenshot' : '',
    ]
      .filter(Boolean)
      .join('  ·  '),
    `<${SITE_URL}/feedback|Open in dashboard →>`,
  ].filter(Boolean);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
      // Don't let a slow Slack hang the server action.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) console.warn('Slack feedback notify failed:', res.status);
  } catch (e) {
    console.warn('Slack feedback notify error:', e);
  }
}
