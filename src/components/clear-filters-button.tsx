'use client';

import { X } from 'lucide-react';

/**
 * "Clear all filters" for a filter / search bar. Always shown so people know it is there;
 * greyed out until a search or filter is set. Every filter bar on the dashboard carries one.
 */
export function ClearFiltersButton({
  active,
  onClear,
  className = '',
}: {
  /** True when any search text or filter differs from its default. */
  active: boolean;
  /** Put every search box and filter of the bar back to its default. */
  onClear: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`wf-btn wf-btn-ghost wf-btn-sm clear-filters-btn ${className}`.trim()}
      disabled={!active}
      title={active ? 'Clear the search and every filter' : 'No search or filter set'}
      onClick={onClear}
    >
      <X size={13} aria-hidden="true" /> Clear all filters
    </button>
  );
}
