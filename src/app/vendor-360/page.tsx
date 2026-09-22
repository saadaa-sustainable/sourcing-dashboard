import { redirect } from 'next/navigation';

// Folded into the dashboard tab as a sub-tab; the old address keeps working.
export default function Page() {
  redirect('/?tab=vendors&view=otif');
}
