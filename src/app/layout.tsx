import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
import './workflows.css';
import { ToastHost } from '@/components/toast-host';

// Design system §4: body + headings use the Helvetica Neue system stack (no webfont);
// only the mono/numeric slot ships a webfont — JetBrains Mono, exposed as --font-jetbrains-mono.
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap' });

export const metadata: Metadata = { title: 'SAADAA Sourcing Dashboard', description: 'Open PO, vendor, TNA, and product sourcing intelligence.' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={jetbrainsMono.variable}><body>{children}<ToastHost /></body></html>;
}
