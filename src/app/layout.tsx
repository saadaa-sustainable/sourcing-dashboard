import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import './workflows.css';
import './analytics-cards.css';
import { ToastHost } from '@/components/toast-host';

// Design system §4 intent: one clean neutral sans for body + headings (hierarchy by
// size/weight, not typeface). We use Inter as that sans — it loads as a webfont so it
// renders identically on Windows and Mac (the doc's "Helvetica Neue" stack would fall
// back to Arial on Windows). JetBrains Mono is the numeric/mono slot.
const inter = Inter({ variable: '--font-inter', subsets: ['latin'], display: 'swap' });
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap' });

export const metadata: Metadata = { title: 'SAADAA Sourcing Dashboard', description: 'Open PO, vendor, TNA, and product sourcing intelligence.' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}><body>{children}<ToastHost /></body></html>;
}
