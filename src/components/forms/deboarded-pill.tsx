import { DEBOARDING_REASON_LABEL } from '@/lib/forms/deboarding';
import type { DeboardedVendor, VendorDeboardingReason } from '@/lib/forms/types';

/**
 * The one mark every vendor-facing page shows for a vendor whose de-boarding has been
 * approved, so nobody raises a PO, logs capacity or reads a scorecard for a vendor the
 * team has already decided to stop working with.
 */
export function DeboardedPill({ flag }: { flag: DeboardedVendor | null | undefined }) {
  if (!flag) return null;
  const on = new Date(flag.approvedAt).toLocaleDateString('en-IN');
  const why = DEBOARDING_REASON_LABEL[flag.reason as VendorDeboardingReason] ?? flag.reason;
  // A form record is the decision as the team wrote it down at the time; there was no
  // approval step to cite, so the tooltip says where it came from instead.
  const how = flag.source === 'google_form' ? 'De-boarded on the Google Form' : 'De-boarding approved';
  return (
    <span className="wf-status tone-red" title={`${how} ${on} — ${why}`}>
      De-boarded {on}
    </span>
  );
}
