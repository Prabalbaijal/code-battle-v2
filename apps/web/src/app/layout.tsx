import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LazyBattleGlobal, LazyVerifyBanner } from '@/components/lazy';
import { SiteHeader } from '@/components/site-header';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'Code Battle', template: '%s · Code Battle' },
  description: 'Real-time 1v1 competitive coding. Challenge a friend, solve first, win coins.',
};

export const viewport: Viewport = {
  themeColor: '#16171f',
  colorScheme: 'dark light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <Providers>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
          >
            Skip to content
          </a>
          <SiteHeader />
          <LazyVerifyBanner />
          <LazyBattleGlobal />
          <main id="main" className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
