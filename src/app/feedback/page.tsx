import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadFeedbackList } from '@/lib/feedback.server';
import { FeedbackClient } from './feedback-client';

export const dynamic = 'force-dynamic';

export default async function FeedbackPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Feedback & Issues" active="/feedback" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const items = await loadFeedbackList(user.email);
  const isAdmin = user.role === 'admin';

  return (
    <FormLayout
      title="Feedback & Issues"
      subtitle={
        isAdmin
          ? 'Developer inbox — every reported bug, suggestion and question. Triage, set status, and reply with screenshots.'
          : 'Report a bug, suggest an improvement, or ask a question. Attach a screenshot and the developer will follow up here.'
      }
      active="/feedback"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <FeedbackClient items={items} isAdmin={isAdmin} email={user.email} />
    </FormLayout>
  );
}
