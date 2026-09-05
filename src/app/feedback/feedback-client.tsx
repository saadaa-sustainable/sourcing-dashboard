'use client';

import { useMemo, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bug, Lightbulb, HelpCircle, Paperclip, Send, Plus, ChevronDown, ImageIcon, X, ThumbsUp, Tag, Link2 } from 'lucide-react';
import { Notice } from '@/components/forms/form-layout';
import { emitToast } from '@/lib/toast';
import { compressImageToDataUrl, captureContext } from '@/lib/image-compress';
import {
  submitFeedback,
  replyFeedback,
  setFeedbackStatus,
  getFeedbackThread,
  toggleFeedbackVote,
} from '@/lib/feedback-actions';
import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_SEVERITY_LABEL,
  FEEDBACK_STATUS_LABEL,
  type FeedbackKind,
  type FeedbackListItem,
  type FeedbackMessage,
  type FeedbackSeverity,
  type FeedbackStatus,
} from '@/lib/feedback';

const KIND_ICON: Record<FeedbackKind, typeof Bug> = { bug: Bug, suggestion: Lightbulb, question: HelpCircle };
const STATUS_TONE: Record<FeedbackStatus, string> = {
  new: 'is-new', acknowledged: 'is-ack', in_progress: 'is-prog', resolved: 'is-done', wont_fix: 'is-wont',
};
const SEV_TONE: Record<FeedbackSeverity, string> = { low: 'is-low', medium: 'is-med', high: 'is-high', blocker: 'is-block' };
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function FeedbackClient({
  items,
  isAdmin,
  email,
}: {
  items: FeedbackListItem[];
  isAdmin: boolean;
  email: string;
}) {
  const params = useSearchParams();
  const [composing, setComposing] = useState(params.get('compose') === '1');
  const fromPath = params.get('from') || undefined;
  const prefill = {
    kind: (params.get('kind') as FeedbackKind | null) || undefined,
    title: params.get('title') || undefined,
    detail: params.get('detail') || undefined,
  };
  const [scope, setScope] = useState<'mine' | 'all'>(isAdmin ? 'all' : 'mine');
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | 'open' | 'all' | 'shipped'>('open');
  const [sortBy, setSortBy] = useState<'recent' | 'votes'>('recent');
  const [openId, setOpenId] = useState<number | null>(null);

  const shown = useMemo(() => {
    const list = items.filter((f) => {
      if (scope === 'mine' && f.submitted_by !== email) return false;
      if (statusFilter === 'shipped') return f.status === 'resolved';
      if (statusFilter === 'open' && (f.status === 'resolved' || f.status === 'wont_fix')) return false;
      if (statusFilter !== 'open' && statusFilter !== 'all' && f.status !== statusFilter) return false;
      return true;
    });
    return sortBy === 'votes'
      ? [...list].sort((a, b) => b.voteCount - a.voteCount || +new Date(b.updated_at) - +new Date(a.updated_at))
      : list;
  }, [items, scope, statusFilter, sortBy, email]);

  const openCount = items.filter((f) => f.status !== 'resolved' && f.status !== 'wont_fix').length;

  return (
    <>
      <div className="fb-bar">
        <button type="button" className="wf-btn wf-btn-primary" onClick={() => setComposing((v) => !v)}>
          <Plus size={15} /> New report
        </button>
        <div className="fb-filters">
          {isAdmin && (
            <div className="segment fb-seg">
              <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>Everyone</button>
              <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Mine</button>
            </div>
          )}
          <div className="segment fb-seg">
            {(['open', 'new', 'in_progress', 'shipped', 'all'] as const).map((s) => (
              <button key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>
                {s === 'open' ? 'Open' : s === 'all' ? 'All' : s === 'shipped' ? 'Shipped ✓' : FEEDBACK_STATUS_LABEL[s as FeedbackStatus]}
              </button>
            ))}
          </div>
          <div className="segment fb-seg">
            <button className={sortBy === 'recent' ? 'active' : ''} onClick={() => setSortBy('recent')}>Recent</button>
            <button className={sortBy === 'votes' ? 'active' : ''} onClick={() => setSortBy('votes')}>Most wanted</button>
          </div>
          <span className="wf-chip">{openCount} open</span>
        </div>
      </div>

      {composing && <ComposeForm fromPath={fromPath} prefill={prefill} onDone={() => setComposing(false)} />}

      <div className="fb-list">
        {shown.map((f) => (
          <FeedbackCard
            key={f.id}
            item={f}
            isAdmin={isAdmin}
            open={openId === f.id}
            onToggle={() => setOpenId(openId === f.id ? null : f.id)}
          />
        ))}
        {!shown.length && (
          <p className="wf-subtle fb-empty">
            {items.length ? 'Nothing matches these filters.' : 'No reports yet — be the first to file one.'}
          </p>
        )}
      </div>
    </>
  );
}

/** Screenshot picker used by both the compose form and the reply box. */
function ShotPicker({ shot, setShot }: { shot: string | null; setShot: (s: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      setShot(await compressImageToDataUrl(file));
    } catch {
      setErr('Could not read that image.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fb-shot">
      {shot ? (
        <div className="fb-shot-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shot} alt="screenshot preview" />
          <button type="button" className="fb-shot-remove" onClick={() => setShot(null)} aria-label="Remove screenshot">
            <X size={13} />
          </button>
        </div>
      ) : (
        <label className="wf-btn wf-btn-ghost wf-btn-sm fb-shot-btn">
          <Paperclip size={13} /> {busy ? 'Adding…' : 'Attach screenshot'}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </label>
      )}
      {err && <span className="fb-err">{err}</span>}
    </div>
  );
}

function ComposeForm({
  fromPath,
  prefill,
  onDone,
}: {
  fromPath?: string;
  prefill?: { kind?: FeedbackKind; title?: string; detail?: string };
  onDone: () => void;
}) {
  const [kind, setKind] = useState<FeedbackKind>(prefill?.kind ?? 'bug');
  const [severity, setSeverity] = useState<FeedbackSeverity>('medium');
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [body, setBody] = useState(prefill?.detail ?? '');
  const [relatedRef, setRelatedRef] = useState('');
  const [tags, setTags] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function submit() {
    setErr(null);
    const fd = new FormData();
    fd.set('kind', kind);
    fd.set('severity', severity);
    fd.set('title', title.trim());
    fd.set('body', body.trim());
    fd.set('related_ref', relatedRef.trim());
    fd.set('tags', tags.trim());
    fd.set('page_path', fromPath || (typeof window !== 'undefined' ? window.location.pathname : ''));
    fd.set('context', JSON.stringify(captureContext()));
    if (shot) fd.set('screenshot', shot);
    start(async () => {
      const res = await submitFeedback(fd);
      if (res.ok) {
        emitToast('Report sent to the developer.', 'success');
        onDone();
        window.location.reload();
      } else setErr(res.error);
    });
  }

  return (
    <div className="fb-compose">
      {err && <Notice tone="error">{err}</Notice>}
      <div className="fb-compose-row">
        <label className="fb-field">
          <span>Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind)}>
            {(Object.keys(FEEDBACK_KIND_LABEL) as FeedbackKind[]).map((k) => (
              <option key={k} value={k}>{FEEDBACK_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="fb-field">
          <span>How urgent</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as FeedbackSeverity)}>
            {(Object.keys(FEEDBACK_SEVERITY_LABEL) as FeedbackSeverity[]).map((s) => (
              <option key={s} value={s}>{FEEDBACK_SEVERITY_LABEL[s]}</option>
            ))}
          </select>
        </label>
        <label className="fb-field fb-field-grow">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="One line — what's wrong or what you'd like" />
        </label>
      </div>
      <label className="fb-field">
        <span>Details</span>
        <textarea
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened, what you expected, and the steps to see it. The page you're on and your browser are attached automatically."
        />
      </label>
      <div className="fb-compose-row">
        <label className="fb-field fb-field-grow">
          <span>Related record <small>(optional — a PO / product / vendor code this is about)</small></span>
          <input value={relatedRef} onChange={(e) => setRelatedRef(e.target.value)} placeholder="e.g. FY26-27/FOB/SDKUR/AGP-014 or SDKUR" />
        </label>
        <label className="fb-field fb-field-grow">
          <span>Tags <small>(optional, comma-separated)</small></span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. buying-plan, mobile, urgent" />
        </label>
      </div>
      <div className="fb-compose-foot">
        <ShotPicker shot={shot} setShot={setShot} />
        <div className="fb-compose-actions">
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onDone} disabled={busy}>Cancel</button>
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={submit} disabled={busy}>
            <Send size={13} /> {busy ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedbackCard({
  item,
  isAdmin,
  open,
  onToggle,
}: {
  item: FeedbackListItem;
  isAdmin: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = KIND_ICON[item.kind];
  const [messages, setMessages] = useState<FeedbackMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!open && messages === null) {
      setLoading(true);
      try {
        const res = await getFeedbackThread(item.id);
        setMessages(res.messages);
      } finally {
        setLoading(false);
      }
    }
    onToggle();
  }

  return (
    <div className={`fb-card${open ? ' is-open' : ''}`}>
      <div className="fb-card-head">
        <button type="button" className="fb-card-expand" onClick={toggle}>
          <span className={`fb-kind fb-kind-${item.kind}`}><Icon size={15} /></span>
          <span className="fb-card-main">
            <span className="fb-card-title">{item.title}</span>
            <span className="fb-card-sub">
              {item.submitted_by ?? '—'} · {when(item.submitted_at)}
              {item.related_ref ? <> · <Link2 size={11} /> {item.related_ref}</> : null}
              {item.page_path ? ` · ${item.page_path}` : ''}
              {item.hasScreenshot ? <> · <ImageIcon size={11} /></> : null}
              {item.messageCount > 1 ? ` · ${item.messageCount} messages` : ''}
            </span>
            {item.tags.length > 0 && (
              <span className="fb-tags">
                {item.tags.map((t) => (
                  <span key={t} className="fb-tag"><Tag size={9} /> {t}</span>
                ))}
              </span>
            )}
          </span>
          <span className={`fb-sev ${SEV_TONE[item.severity]}`}>{FEEDBACK_SEVERITY_LABEL[item.severity]}</span>
          <span className={`fb-status ${STATUS_TONE[item.status]}`}>{FEEDBACK_STATUS_LABEL[item.status]}</span>
          <ChevronDown size={16} className="fb-chev" />
        </button>
        <VoteButton item={item} />
      </div>

      {item.status === 'resolved' && item.resolution && (
        <div className="fb-shipped">✓ Shipped — {item.resolution}</div>
      )}

      {open && (
        <div className="fb-thread">
          {isAdmin && <StatusBar item={item} />}
          {loading && <p className="wf-subtle">Loading…</p>}
          {messages?.map((m) => (
            <div key={m.id} className={`fb-msg${m.author_email === item.submitted_by ? '' : ' is-dev'}`}>
              <div className="fb-msg-head">
                <strong>{m.author_email ?? '—'}</strong>
                <span className="wf-subtle">{when(m.created_at)}</span>
              </div>
              {m.body && <p className="fb-msg-body">{m.body}</p>}
              {m.screenshot && (
                <a href={m.screenshot} target="_blank" rel="noopener noreferrer" className="fb-msg-shot">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.screenshot} alt="attached screenshot" />
                </a>
              )}
            </div>
          ))}
          <ReplyBox feedbackId={item.id} />
        </div>
      )}
    </div>
  );
}

function VoteButton({ item }: { item: FeedbackListItem }) {
  const [busy, start] = useTransition();
  function toggle() {
    const fd = new FormData();
    fd.set('feedback_id', String(item.id));
    start(async () => {
      const r = await toggleFeedbackVote(fd);
      if (r.ok) window.location.reload();
    });
  }
  return (
    <button
      type="button"
      className={`fb-vote${item.votedByMe ? ' is-voted' : ''}`}
      onClick={toggle}
      disabled={busy}
      title={item.votedByMe ? 'Remove your vote' : 'Me too — I want this / hit this too'}
    >
      <ThumbsUp size={13} /> {item.voteCount}
    </button>
  );
}

function StatusBar({ item }: { item: FeedbackListItem }) {
  const [busy, start] = useTransition();
  const [assignee, setAssignee] = useState(item.assignee ?? '');
  const [resolution, setResolution] = useState(item.resolution ?? '');

  function set(status: FeedbackStatus) {
    const fd = new FormData();
    fd.set('feedback_id', String(item.id));
    fd.set('status', status);
    fd.set('assignee', assignee.trim());
    fd.set('resolution', resolution.trim());
    start(async () => {
      const res = await setFeedbackStatus(fd);
      if (res.ok) {
        emitToast(res.message ?? 'Updated.', 'success');
        window.location.reload();
      }
    });
  }
  return (
    <div className="fb-statusbar">
      <div className="fb-status-row">
        <span className="wf-subtle">Status:</span>
        {(Object.keys(FEEDBACK_STATUS_LABEL) as FeedbackStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`wf-btn wf-btn-sm ${item.status === s ? 'wf-btn-primary' : 'wf-btn-ghost'}`}
            disabled={busy || item.status === s}
            onClick={() => set(s)}
          >
            {FEEDBACK_STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="fb-status-row">
        <label className="fb-field">
          <span>Assignee</span>
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="dev email" />
        </label>
        <label className="fb-field fb-field-grow">
          <span>Resolution note <small>(shown in “Shipped ✓”)</small></span>
          <input value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="What was done — visible to the reporter when resolved" />
        </label>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => set(item.status)}>
          Save note
        </button>
      </div>
    </div>
  );
}

function ReplyBox({ feedbackId }: { feedbackId: number }) {
  const [body, setBody] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function send() {
    setErr(null);
    const fd = new FormData();
    fd.set('feedback_id', String(feedbackId));
    fd.set('body', body.trim());
    if (shot) fd.set('screenshot', shot);
    start(async () => {
      const res = await replyFeedback(fd);
      if (res.ok) {
        emitToast('Reply added.', 'success');
        window.location.reload();
      } else setErr(res.error);
    });
  }

  return (
    <div className="fb-reply">
      {err && <Notice tone="error">{err}</Notice>}
      <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Reply… (attach a screenshot for clarity)" />
      <div className="fb-reply-foot">
        <ShotPicker shot={shot} setShot={setShot} />
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={send} disabled={busy}>
          <Send size={13} /> {busy ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}
