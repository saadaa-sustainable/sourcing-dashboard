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
  return (
    <span className="wf-status tone-red" title={`De-boarding approved ${on} — ${why}`}>
      De-boarded {on}
    </span>
  );
}
