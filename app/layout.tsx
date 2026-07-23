import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { cn } from '@/lib/utils'
import { APP_NAME } from '@/lib/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: APP_NAME,
  description:
    'A Mermaid diagram editor where your GitHub repository is the database.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Diagram theme presets set fontFamily: 'JetBrains Mono' (lib/themes.ts),
            baked verbatim into mermaid's rendered SVG — that literal family name
            must resolve to a real @font-face, so it's loaded by name here rather
            than via next/font (which renames the family to an obfuscated class). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap"
        />
      </head>
      <body className={cn('font-sans antialiased', geist.variable, geistMono.variable)}>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
