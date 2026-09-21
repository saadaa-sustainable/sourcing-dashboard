import { redirect } from 'next/navigation';

/**
 * The Inward Plan lives on /receivable-plan, which carries both halves of it: Arrivals (what
 * was expected against what landed) and Input Inward Plan (where the team enters what to
 * expect and when). This route used to be a third, read-only view of the same subject, so it
 * redirects rather than competing with the page that owns the name.
 */
export default function InwardPlanRedirect() {
  redirect('/receivable-plan');
}
