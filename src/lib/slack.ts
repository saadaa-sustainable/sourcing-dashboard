// Slack notifier. Posts to Slack Incoming Webhooks whose URLs live ONLY in env vars
// (never hardcoded). Best-effort: no-ops if the relevant var is unset, and never
// throws — a Slack outage/misconfig must never block or slow the underlying action.
// Incoming webhooks send text only (no file upload), so screenshots/records are
// linked back to the dashboard.
//
// Channels:
//   SLACK_FEEDBACK_WEBHOOK_URL — the feedback channel (bugs/suggestions).
//   SLACK_OPS_WEBHOOK_URL      — operations (EFOB rate updates, rework). Falls back
//                                to the feedback webhook if unset, so one webhook
//                                works out of the box; add a second to split them.

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://sourcing-dashboard-coral.vercel.app').replace(/\/$/, '');

/** Low-level best-effort poster. */
async function postSlack(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return; // channel not configured — no-op
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) console.warn('Slack notify failed:', res.status);
  } catch (e) {
    console.warn('Slack notify error:', e);
  }
}

const feedbackWebhook = () => process.env.SLACK_FEEDBACK_WEBHOOK_URL;
const opsWebhook = () => process.env.SLACK_OPS_WEBHOOK_URL || process.env.SLACK_FEEDBACK_WEBHOOK_URL;
const link = (path: string, label: string) => `<${SITE_URL}${path}|${label}>`;

// ── Feedback ────────────────────────────────────────────────────────────────
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
    ].filter(Boolean).join('  ·  '),
    link('/feedback', 'Open in dashboard →'),
  ].filter(Boolean);
  await postSlack(feedbackWebhook(), lines.join('\n'));
}

// ── Monthly EFOB / fabric rate updates ───────────────────────────────────────
export async function notifyFabricRateSlack(n: {
  fabricCode: string;
  noChange: boolean;
  greyRate: number | null;
  finishedRate: number | null;
  by: string | null;
  month: string;
}): Promise<void> {
  const rates =
    n.noChange
      ? 'no change this month'
      : `grey ${n.greyRate ?? '—'} · finished ${n.finishedRate ?? '—'}`;
  const text = [
    `🧵 *Fabric rate submitted* — *${n.fabricCode}* (${n.month.slice(0, 7)})`,
    `${rates}${n.by ? `  ·  👤 ${n.by}` : ''}`,
    link('/fabric-cost', 'View / see what’s still pending →'),
  ].join('\n');
  await postSlack(opsWebhook(), text);
}

// ── Rework sent back to a submitter ──────────────────────────────────────────
export async function notifyReworkSlack(n: {
  what: string; // e.g. "Buying plan 2026-09" or a PO ref
  submitter?: string | null;
  by?: string | null; // who sent it back
  reason?: string | null;
  scope?: string | null; // e.g. "3 lines"
}): Promise<void> {
  const text = [
    `↩️ *Sent back for rework:* ${n.what}${n.scope ? ` (${n.scope})` : ''}`,
    n.submitter ? `👤 ${n.submitter} needs to revise${n.by ? ` — returned by ${n.by}` : ''}` : '',
    n.reason ? `>${n.reason.slice(0, 400)}` : '',
    link('/my-dashboard', 'Open your submissions →'),
  ].filter(Boolean).join('\n');
  await postSlack(opsWebhook(), text);
}
