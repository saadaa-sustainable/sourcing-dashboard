import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import './workflows.css';
import './analytics-cards.css';
import { ToastHost } from '@/components/toast-host';

// Design system §4 intent: one clean neutral sans for body + headings (hierarchy by
// size/weight, not typeface). We use Inter as that sans — it loads as a webfont so it
// renders identically on Windows and Mac (the doc's "Helvetica Neue" stack would fall
// back to Arial on Windows). JetBrains Mono is the numeric/mono slot.
//
// Self-hosted (next/font/local) rather than next/font/google: fetching from Google
// Fonts at `next build` was a hard external build-time dependency — any outage or
// firewall between the builder and fonts.gstatic.com broke deploys. These are the
// latin-subset VARIABLE woff2 files (one file covers the whole weight range), served
// from our own origin. `adjustFontFallback` keeps the metric-matched fallback that
// next/font/google gave us for free.
const inter = localFont({
  src: './fonts/InterVariable.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
  fallback: ['system-ui', 'arial'],
  adjustFontFallback: 'Arial',
});
const jetbrainsMono = localFont({
  src: './fonts/JetBrainsMono.woff2',
  variable: '--font-jetbrains-mono',
  display: 'swap',
  weight: '400 600',
  fallback: ['ui-monospace', 'monospace'],
});

export const metadata: Metadata = { title: 'SAADAA Sourcing Dashboard', description: 'Open PO, vendor, TNA, and product sourcing intelligence.' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}><body>{children}<ToastHost /></body></html>;
}
