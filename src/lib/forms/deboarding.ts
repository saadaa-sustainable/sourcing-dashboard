/**
 * Vendor De-Boarding vocabulary, shared by the form, the server action and the approvals
 * queue. Plain module (no 'use server' / 'use client') so both sides can import it.
 *
 * Mirrors the team's Google Form ("VENDOR DE-BOARDING FORM") field for field; the labels
 * are the form's own words, tidied so each one says what it counts.
 */
import type { VendorDeboardingReason } from './types';

export const DEBOARDING_REASONS: { key: VendorDeboardingReason; label: string }[] = [
  { key: 'behavioural', label: 'Behavioural issue' },
  { key: 'delay', label: 'Delay in meeting timelines' },
  { key: 'quality', label: 'Quality issue' },
  { key: 'unethical', label: 'Unethical practice' },
  { key: 'process_gap', label: 'Process gap' },
  { key: 'other', label: 'Other' },
];

export const DEBOARDING_REASON_LABEL: Record<VendorDeboardingReason, string> = Object.fromEntries(
  DEBOARDING_REASONS.map((r) => [r.key, r.label]),
) as Record<VendorDeboardingReason, string>;

/** The form's four 1–5 ratings, in the form's order. */
export const DEBOARDING_SCORES: {
  key: 'behaviour_score' | 'work_style_score' | 'quality_score' | 'process_score';
  label: string;
  short: string;
}[] = [
  { key: 'behaviour_score', label: 'Vendor behaviour', short: 'Behaviour' },
  { key: 'work_style_score', label: 'Vendor work style', short: 'Work style' },
  { key: 'quality_score', label: 'Vendor product quality', short: 'Quality' },
  { key: 'process_score', label: "Vendor's understanding of SAADAA's process", short: 'Process' },
];

/** What the ends of the 1–5 scale mean, shown once beside the ratings. */
export const SCORE_SCALE = '1 = very poor · 5 = excellent';
