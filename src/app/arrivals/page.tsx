import { redirect } from 'next/navigation';

/**
 * Arrivals is a tab on the Inward Plan, not a page of its own — the same view in two places
 * was one place too many. Old links land on the page that owns it.
 */
export default function ArrivalsRedirect() {
  redirect('/receivable-plan');
}
