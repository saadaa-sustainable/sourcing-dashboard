'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Bot, ChevronDown, ChevronRight, Plus, Send, UserRound } from 'lucide-react';
import { Field, Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { emitToast, reloadWithToast } from '@/lib/toast';
import { getIssueThread, raiseIssue, replyIssue, saveIssueRoute, updateIssue } from '@/lib/issue-actions';
import {
  ISSUE_CATEGORIES,
  ISSUE_CATEGORY_LABEL,
  ISSUE_SEVERITY_LABEL,
  ISSUE_STATUS_LABEL,
  computeIssueStats,
  daysOpen,
  isIssueOpen,
  type IssueCategory,
  type IssueMessage,
  type IssueRoute,
  type IssueRow,
  type IssueSeverity,
} from '@/lib/issues';

type Person = { email: string; name: string };

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const who = (email: string | null, people: Person[]) => {
  if (!email) return 'Unassigned';
  if (email === 'system') return 'Dashboard check';
  return people.find((p) => p.email === email)?.name ?? email;
};

type Tab = 'open' | 'mine' | 'resolved' | 'all';

export function IssuesClient({
  issues,
  routes,
  people,
  email,
  isAdmin,
  canAct,
}: {
  issues: IssueRow[];
  routes: IssueRoute[];
  people: Person[];
  email: string;
  isAdmin: boolean;
  canAct: boolean;
}) {
  const params = useSearchParams();
  const initialCategory = (params.get('category') ?? '') as IssueCategory | '';
  const [tab, setTab] = useState<Tab>('open');
  const [category, setCategory] = useState<IssueCategory | ''>(ISSUE_CATEGORIES.some((c) => c.key === initialCategory) ? initialCategory : '');
  const [assignee, setAssignee] = useState('');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [composing, setComposing] = useState(params.get('raise') === '1');
  const [openId, setOpenId] = useState<number | null>(null);

  const stats = useMemo(() => computeIssueStats(issues), [issues]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return issues.filter((i) => {
      if (tab === 'open' && !isIssueOpen(i.status)) return false;
      if (tab === 'mine' && !(i.assignee === email || i.raised_by === email)) return false;
      if (tab === 'resolved' && isIssueOpen(i.status)) return false;
      if (category && i.category !== category) return false;
      if (assignee === 'unassigned' ? !!i.assignee : assignee ? i.assignee !== assignee : false) return false;
      if (q && !`${i.title} ${i.detail ?? ''} ${i.related_ref ?? ''} ${i.raised_by ?? ''} ${i.assignee ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [issues, tab, category, assignee, search, email]);

  return (
    <div className="iss">
      {/* The numbers people quote. */}
      <div className="oos-kpi-grid four">
        <div className="oos-kpi panel">
          <span>
            Open issues
            <InfoDot text={"WHAT: issues nobody has resolved or dismissed yet — Open plus In progress.\n\nHOW: a count of rows in those two states, raised by people and by the dashboard's own checks alike.\n\nUSE: the same number sits on the Main Dashboard's Objectives tab. It should trend down; if it only ever grows, issues are being raised and not worked."} />
          </span>
          <strong>{fmt.format(stats.open)}</strong>
          <small>{fmt.format(stats.inProgress)} in progress · {fmt.format(stats.autoOpen)} raised by the dashboard</small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Unassigned
            <InfoDot text={"WHAT: open issues with nobody's name on them.\n\nHOW: open or in-progress rows whose assignee is blank. An issue is blank when it was raised to a category that has no route, and no one picked it up.\n\nUSE: should be zero. Set a route per category below (admin) so new issues land on someone automatically."} />
          </span>
          <strong>{fmt.format(stats.unassigned)}</strong>
          <small>nobody is on them yet</small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Days to resolve
            <InfoDot text={"WHAT: how long an issue takes from being raised to being resolved.\n\nHOW: for issues resolved in the last 30 days, resolved date − raised date, in whole days, averaged. Example: three issues taking 2, 4 and 9 days → 5 days.\n\nUSE: the team's response time. Read it with 'oldest open' beside it: a low average and one very old issue means one thing is stuck."} />
          </span>
          <strong>{stats.avgDaysToResolve30 == null ? '—' : stats.avgDaysToResolve30}</strong>
          <small>
            average over {fmt.format(stats.resolvedLast30)} resolved in the last 30 days
          </small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Oldest open
            <InfoDot text={"WHAT: how many days the longest-standing open issue has been waiting.\n\nHOW: today − raised date of the oldest open or in-progress issue.\n\nUSE: the one to look at first. Sort the list by days to find it."} />
          </span>
          <strong>{stats.oldestOpenDays == null ? '—' : `${stats.oldestOpenDays}d`}</strong>
          <small>{stats.byCategory[0] ? `most open: ${ISSUE_CATEGORY_LABEL[stats.byCategory[0].category]} (${stats.byCategory[0].open})` : 'nothing open'}</small>
        </div>
      </div>

      <div className="iss-bar">
        <div className="role-tabs" role="tablist" aria-label="Issue views">
          {(['open', 'mine', 'resolved', 'all'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'open' ? 'Open' : t === 'mine' ? 'Mine' : t === 'resolved' ? 'Resolved / dismissed' : 'All'}
            </button>
          ))}
        </div>
        <div className="iss-filters">
          <select value={category} onChange={(e) => setCategory(e.target.value as IssueCategory | '')} aria-label="Category">
            <option value="">All categories</option>
            {ISSUE_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
          <input value={search} placeholder="Search title, PO, product, person…" onChange={(e) => setSearch(e.target.value)} />
          {canAct && (
            <button type="button" className="wf-btn wf-btn-primary" onClick={() => setComposing((v) => !v)}>
              <Plus size={14} /> Raise an issue
            </button>
          )}
        </div>
      </div>

      {composing && canAct && (
        <RaiseForm
          people={people}
          routes={routes}
          initialCategory={category || 'po'}
          onDone={() => {
            setComposing(false);
            reloadWithToast();
          }}
        />
      )}

      <div className="table-panel">
        <div className="table-meta">
          <h3>Issues</h3>
          <span>{fmt.format(shown.length)} shown</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table iss-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>About</th>
                <th>Raised by</th>
                <th>Assigned to</th>
                <th className="num">Days</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <IssueRowView
                  key={i.id}
                  issue={i}
                  people={people}
                  open={openId === i.id}
                  onToggle={() => setOpenId((cur) => (cur === i.id ? null : i.id))}
                  canAct={canAct}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="wf-empty-cell">
                    {tab === 'open' ? 'Nothing open — good.' : 'No issues match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <RoutingPanel routes={routes} people={people} isAdmin={isAdmin} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RaiseForm({
  people,
  routes,
  initialCategory,
  onDone,
}: {
  people: Person[];
  routes: IssueRoute[];
  initialCategory: IssueCategory;
  onDone: () => void;
}) {
  const [category, setCategory] = useState<IssueCategory>(initialCategory);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [ref, setRef] = useState('');
  const [severity, setSeverity] = useState<IssueSeverity>('medium');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const routed = routes.find((r) => r.category === category)?.assignee ?? null;

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set('category', category);
    fd.set('title', title);
    fd.set('detail', detail);
    fd.set('related_ref', ref);
    fd.set('severity', severity);
    fd.set('assignee', assignee);
    fd.set('page_path', '/issues');
    start(async () => {
      const r = await raiseIssue(fd);
      if (r.ok) {
        emitToast(r.message ?? 'Raised.');
        onDone();
      } else setError(r.error);
    });
  }

  return (
    <div className="panel wf-form-panel">
      <div className="panel-title">
        <h3>Raise an issue</h3>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="wf-form-grid">
        <Field label="What is it about?" hint={routed ? `This category routes to ${who(routed, people)}` : 'No one is routed for this category — pick a person, or it waits unassigned'}>
          <select value={category} onChange={(e) => setCategory(e.target.value as IssueCategory)}>
            {ISSUE_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Raise it to" hint="Leave blank to use the category's route">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{routed ? `Route: ${who(routed, people)}` : 'Nobody yet'}</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PO / product / vendor code" hint="Optional — what the issue is about">
          <input value={ref} placeholder="e.g. FY26-27/FOB/SDFLK/KVN-03" onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="How urgent">
          <select value={severity} onChange={(e) => setSeverity(e.target.value as IssueSeverity)}>
            {(Object.keys(ISSUE_SEVERITY_LABEL) as IssueSeverity[]).map((s) => (
              <option key={s} value={s}>
                {ISSUE_SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What is wrong — one line">
          <input value={title} placeholder="e.g. This PO is coming with the wrong quantity" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Detail" hint="What you saw, where, and what should happen instead">
          <textarea className="wf-textarea" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} />
        </Field>
      </div>
      <div className="wf-footer-actions">
        <button type="button" className="wf-btn wf-btn-primary" disabled={pending || !title.trim()} onClick={submit}>
          <Send size={14} /> {pending ? 'Raising…' : 'Raise'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function IssueRowView({
  issue: i,
  people,
  open,
  onToggle,
  canAct,
}: {
  issue: IssueRow;
  people: Person[];
  open: boolean;
  onToggle: () => void;
  canAct: boolean;
}) {
  const days = daysOpen(i.raised_at, i.resolved_at);
  const live = isIssueOpen(i.status);
  return (
    <>
      <tr className={`iss-row${open ? ' is-open' : ''}${live ? '' : ' is-closed'}`} onClick={onToggle} role="button" aria-expanded={open}>
        <td>
          <span className="iss-title">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {i.source === 'auto' ? <Bot size={13} className="iss-bot" aria-label="Raised by the dashboard" /> : null}
            <b>{i.title}</b>
            {i.severity === 'high' || i.severity === 'blocker' ? <span className={`iss-sev is-${i.severity}`}>{ISSUE_SEVERITY_LABEL[i.severity]}</span> : null}
            {i.messageCount ? <small className="wf-subtle">· {i.messageCount} repl{i.messageCount === 1 ? 'y' : 'ies'}</small> : null}
          </span>
        </td>
        <td>
          <span className="iss-cat">{ISSUE_CATEGORY_LABEL[i.category]}</span>
          {i.related_ref ? <small className="mono wf-subtle"> {i.related_ref}</small> : null}
        </td>
        <td className="wf-subtle">
          {who(i.raised_by, people)}
          <small> · {when(i.raised_at)}</small>
        </td>
        <td>{i.assignee ? who(i.assignee, people) : <span className="iss-unassigned">Unassigned</span>}</td>
        <td className={`num tabular${live && days >= 7 ? ' oos-worse' : ''}`}>{days}</td>
        <td>
          <span className={`iss-status is-${i.status}`}>{ISSUE_STATUS_LABEL[i.status]}</span>
        </td>
      </tr>
      {open && (
        <tr className="iss-detail">
          <td colSpan={6}>
            <IssueDetail issue={i} people={people} canAct={canAct} />
          </td>
        </tr>
      )}
    </>
  );
}

function IssueDetail({ issue: i, people, canAct }: { issue: IssueRow; people: Person[]; canAct: boolean }) {
  const [messages, setMessages] = useState<IssueMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState(i.assignee ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const live = isIssueOpen(i.status);

  useEffect(() => {
    let alive = true;
    getIssueThread(i.id).then((t) => {
      if (alive) setMessages(t.messages);
    });
    return () => {
      alive = false;
    };
  }, [i.id]);

  function act(action: string) {
    setError(null);
    const fd = new FormData();
    fd.set('issue_id', String(i.id));
    fd.set('action', action);
    fd.set('note', note);
    fd.set('assignee', assignee);
    start(async () => {
      const r = await updateIssue(fd);
      if (r.ok) reloadWithToast();
      else setError(r.error);
    });
  }
  function send() {
    setError(null);
    const fd = new FormData();
    fd.set('issue_id', String(i.id));
    fd.set('body', reply);
    start(async () => {
      const r = await replyIssue(fd);
      if (r.ok) {
        setReply('');
        const t = await getIssueThread(i.id);
        setMessages(t.messages);
      } else setError(r.error);
    });
  }

  return (
    <div className="iss-detail-body" onClick={(e) => e.stopPropagation()}>
      {i.detail && <p className="iss-detail-text">{i.detail}</p>}
      <dl className="wf-queue-meta">
        <div>
          <dt>Raised</dt>
          <dd>
            {who(i.raised_by, people)} · {when(i.raised_at)}
            {i.page_path ? (
              <>
                {' '}
                · <Link href={i.page_path}>open the page →</Link>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Assigned</dt>
          <dd>
            {i.assignee ? `${who(i.assignee, people)} · ${i.assigned_via === 'route' ? 'by category route' : 'by hand'} · ${when(i.assigned_at)}` : 'Nobody yet'}
          </dd>
        </div>
        {i.resolved_at && (
          <div>
            <dt>{i.status === 'dismissed' ? 'Dismissed' : 'Resolved'}</dt>
            <dd>
              {who(i.resolved_by, people)} · {when(i.resolved_at)} · after {daysOpen(i.raised_at, i.resolved_at)} day
              {daysOpen(i.raised_at, i.resolved_at) === 1 ? '' : 's'}
              {i.resolution ? <p className="iss-resolution">{i.resolution}</p> : null}
            </dd>
          </div>
        )}
      </dl>

      <div className="iss-thread">
        {messages == null ? (
          <p className="wf-subtle">Loading…</p>
        ) : messages.length ? (
          messages.map((m) => (
            <div key={m.id} className="iss-msg">
              <span className="iss-msg-who">
                <UserRound size={12} /> {who(m.author_email, people)} <small>{when(m.created_at)}</small>
              </span>
              <p>{m.body}</p>
            </div>
          ))
        ) : (
          <p className="wf-subtle">No replies yet.</p>
        )}
        {canAct && (
          <div className="iss-reply">
            <input value={reply} placeholder="Reply…" onChange={(e) => setReply(e.target.value)} />
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending || !reply.trim()} onClick={send}>
              <Send size={13} /> Send
            </button>
          </div>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {canAct && (
        <div className="iss-actions">
          {live ? (
            <>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign to">
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.email} value={p.email}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending || assignee === (i.assignee ?? '')} onClick={() => act('assign')}>
                Assign
              </button>
              {i.status === 'open' && (
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => act('start')}>
                  Start working
                </button>
              )}
              <input className="iss-note" value={note} placeholder="What was done / why not an issue" onChange={(e) => setNote(e.target.value)} />
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !note.trim()} onClick={() => act('resolve')}>
                Resolve
              </button>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending || !note.trim()} onClick={() => act('dismiss')}>
                Dismiss
              </button>
            </>
          ) : (
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => act('reopen')}>
              Reopen
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RoutingPanel({ routes, people, isAdmin }: { routes: IssueRoute[]; people: Person[]; isAdmin: boolean }) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(routes.map((r) => [r.category, r.assignee ?? ''])),
  );
  function save(category: string) {
    const fd = new FormData();
    fd.set('category', category);
    fd.set('assignee', draft[category] ?? '');
    start(async () => {
      const r = await saveIssueRoute(fd);
      if (r.ok) emitToast(r.message ?? 'Saved.');
      else emitToast(r.error);
    });
  }
  return (
    <section className="panel iss-routes">
      <div className="panel-title">
        <div>
          <span className="panel-kicker">Who picks up what</span>
          <h3>
            Routing by category
            <InfoDot text={"WHAT: the person each kind of issue lands on automatically.\n\nHOW: an issue raised to a category with no person named goes to that category's route; the dashboard's own auto-raised issues always go by route. A route left blank means those issues wait unassigned until someone picks them up.\n\nUSE: set one person per category so nothing sits unowned. Only an admin can change these."} />
          </h3>
        </div>
      </div>
      <div className="table-scroll">
        <table className="wide-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Routes to</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.category}>
                <td>{r.label}</td>
                <td>
                  {isAdmin ? (
                    <select value={draft[r.category] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [r.category]: e.target.value }))}>
                      <option value="">Nobody (waits unassigned)</option>
                      {people.map((p) => (
                        <option key={p.email} value={p.email}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  ) : r.assignee ? (
                    who(r.assignee, people)
                  ) : (
                    <span className="iss-unassigned">Nobody yet</span>
                  )}
                </td>
                {isAdmin && (
                  <td>
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      disabled={pending || (draft[r.category] ?? '') === (r.assignee ?? '')}
                      onClick={() => save(r.category)}
                    >
                      Save
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
