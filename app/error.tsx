'use client'

import { useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import { APP_NAME } from '@/lib/config'
import { Button } from '@/components/ui/button'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
      <p className="text-sm font-medium text-muted-foreground">{APP_NAME}</p>
      <h1 className="text-4xl font-bold tracking-tight">Something went wrong</h1>
      <p className="max-w-sm text-muted-foreground">
        An unexpected error occurred. Your draft is safe in your browser — try again.
      </p>
      <Button size="lg" className="mt-4" onClick={() => reset()}>
        <RotateCcw /> Try again
      </Button>
    </div>
  )
}
