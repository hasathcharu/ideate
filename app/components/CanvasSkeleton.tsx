import { Skeleton } from '@/components/ui/skeleton'

/** Shared placeholder for scene download, bundle load, and editor initialization. */
export default function CanvasSkeleton({ overlay = false }: { overlay?: boolean }) {
  return (
    <section className={overlay
      ? 'absolute inset-0 z-[1000] flex flex-col gap-5 bg-background p-5'
      : 'flex h-full min-h-0 flex-1 flex-col gap-5 bg-background p-5'}
      aria-busy aria-label="Loading canvas">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="ml-auto h-9 w-40" />
      </div>
      <div className="flex flex-1 items-center justify-center gap-12 rounded-md border border-dashed border-border/60">
        <Skeleton className="h-24 w-32 rounded-xl" />
        <Skeleton className="h-32 w-40 rounded-xl" />
      </div>
    </section>
  )
}
