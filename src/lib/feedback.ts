// Client-safe feedback types + label maps. Kept separate from feedback.server.ts
// (which imports the Supabase server client → next/headers) so client components can
// use these without pulling server-only code into the client bundle.

export type FeedbackKind = 'bug' | 'suggestion' | 'question';
export type FeedbackSeverity = 'low' | 'medium' | 'high' | 'blocker';
export type FeedbackStatus = 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'wont_fix';

export type FeedbackMessage = {
  id: number;
  feedback_id: number;
  author_email: string | null;
  body: string | null;
  screenshot: string | null; // base64 data URL
  created_at: string;
};

export type FeedbackListItem = {
  id: number;
  kind: FeedbackKind;
  title: string;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  page_path: string | null;
  submitted_by: string | null;
  submitted_at: string;
  updated_at: string;
  messageCount: number;
  hasScreenshot: boolean;
};

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: 'Bug / problem',
  suggestion: 'Suggestion',
  question: 'Question',
};
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};
export const FEEDBACK_SEVERITY_LABEL: Record<FeedbackSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  blocker: 'Blocker',
};
