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

// ── Buying Plan month-end report (spec item 5) ───────────────────────────────
//   SLACK_SUPPLY_CHAIN_WEBHOOK_URL — the Supply Chain channel. Falls back to the ops
//   webhook so the report still lands somewhere until the dedicated webhook is added.
const supplyChainWebhook = () => process.env.SLACK_SUPPLY_CHAIN_WEBHOOK_URL || opsWebhook();

/** True when some webhook will receive the month report (used to report "not configured"). */
export function hasSupplyChainSlack(): boolean {
  return Boolean(supplyChainWebhook());
}

export type SlackReportTarget = 'supply_chain' | 'ops' | 'feedback' | 'none';

/**
 * Which webhook the month report will actually go to — the dedicated Supply Chain one, or
 * a fallback. Surfaced on the report card so nobody has to guess which channel receives it.
 */
export function slackReportTarget(): SlackReportTarget {
  if (process.env.SLACK_SUPPLY_CHAIN_WEBHOOK_URL) return 'supply_chain';
  if (process.env.SLACK_OPS_WEBHOOK_URL) return 'ops';
  if (process.env.SLACK_FEEDBACK_WEBHOOK_URL) return 'feedback';
  return 'none';
}

export type PlanReportNotice = {
  monthLabel: string; // "September 2026"
  plannedQty: number;
  issuedQty: number;
  plannedValue: number;
  issuedValue: number;
  excessPct: number | null;
  shortQty: number;
  notBudgeted: number; // products issued but not budgeted (exception a)
  overApproved: number; // products issued above approved (exception b)
  compliance: string; // human line, e.g. "Approved on time" / "Breach — approval side, 9 days late"
  pdfUrl: string | null; // signed URL to the PDF (null if storage failed)
  analysisPath: string; // dashboard path for the month's analysis
};

/** Posts the month-close summary + PDF link to the Supply Chain channel. Returns false when no webhook is set. */
export async function notifyPlanReportSlack(n: PlanReportNotice): Promise<boolean> {
  const hook = supplyChainWebhook();
  if (!hook) return false;
  const inr = (v: number) =>
    Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString('en-IN')}`;
  const pcs = (v: number) => `${Math.round(v).toLocaleString('en-IN')} pcs`;
  const text = [
    `📊 *Buying Plan — ${n.monthLabel} closed.* Month report is ready.`,
    `• Issued *${pcs(n.issuedQty)}* vs approved ${pcs(n.plannedQty)}  ·  ${inr(n.issuedValue)} vs ${inr(n.plannedValue)}`,
    `• Excess ${n.excessPct == null ? '—' : `${(n.excessPct * 100).toFixed(1)}%`}  ·  Short ${pcs(n.shortQty)}`,
    `• ⚠️ Not budgeted: *${n.notBudgeted}* product${n.notBudgeted === 1 ? '' : 's'}  ·  Over approved: *${n.overApproved}*`,
    `• Approval compliance: ${n.compliance}`,
    n.pdfUrl ? `📎 <${n.pdfUrl}|Download the PDF report>` : '📎 PDF could not be stored — open the analysis instead.',
    link(n.analysisPath, 'Open Buying Plan Analysis →'),
  ].join('\n');
  await postSlack(hook, text);
  return true;
}

// ── Month-end auto-submit of next month's plan ───────────────────────────────
export async function notifyPlanAutoSubmitSlack(n: {
  monthLabel: string;
  outcome: 'submitted' | 'no_plan' | 'empty';
  detail: string;
  planMonth?: string;
}): Promise<void> {
  const head =
    n.outcome === 'submitted'
      ? `📤 *Buying plan auto-submitted* — ${n.monthLabel}`
      : `⚠️ *Buying plan NOT auto-submitted* — ${n.monthLabel}`;
  const text = [
    head,
    n.detail,
    n.outcome === 'submitted'
      ? link('/approvals', 'Approve it before the deadline →')
      : link(`/buying-plan${n.planMonth ? `?month=${n.planMonth}` : ''}`, 'Open the Buying Plan →'),
  ].join('\n');
  await postSlack(opsWebhook(), text);
}

// ── Post-approval / post-freeze amendment request ────────────────────────────
export async function notifyPlanAmendmentSlack(n: {
  monthLabel: string;
  by: string;
  note: string;
  frozen: boolean;
}): Promise<void> {
  const text = [
    `✏️ *Buying plan amendment requested* — ${n.monthLabel}${n.frozen ? ' (month already closed)' : ''}`,
    `👤 ${n.by}`,
    `>${n.note.slice(0, 400)}`,
    'The plan is back in rework; it must be re-approved before the change counts.',
    link('/approvals', 'Open the Approvals queue →'),
  ].join('\n');
  await postSlack(opsWebhook(), text);
}
