import type { Metadata } from 'next'
import { Geist_Mono, Poppins } from 'next/font/google'
import { cn } from '@/lib/utils'
import { APP_NAME } from '@/lib/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
})
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
      <body className={cn('font-sans antialiased', poppins.variable, geistMono.variable)}>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
