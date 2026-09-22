'use client';

import { usePathname } from 'next/navigation';
import { InfoDot } from '@/components/info-dot';
import { headerHelp } from '@/lib/header-help';

/**
 * The (i) beside a table header. Given the header's text it finds the plain-words
 * description in lib/header-help.ts — page-specific first, then the shared meaning — so
 * every header on every page explains itself without each table carrying its own copy.
 * Pass `text` to override for one header.
 */
export function HeaderInfo({ label, text }: { label: string; text?: string | null }) {
  const pathname = usePathname();
  const help = text ?? headerHelp(label, pathname);
  if (!help) return null;
  return <InfoDot text={help} label={`About ${label}`} />;
}
