'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { Popover } from 'radix-ui'
import { BUILTIN_THEMES, SHIKI_THEMES } from '@/lib/themes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface ThemeSelectProps {
  value: string
  onChange: (id: string) => void
  loading?: boolean
}

interface ThemeOption {
  id: string
  label: string
}

export default function ThemeSelect({ value, onChange, loading }: ThemeSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const current = useMemo(
    () => [...BUILTIN_THEMES, ...SHIKI_THEMES].find((t) => t.id === value),
    [value],
  )

  const q = query.trim().toLowerCase()
  const match = (t: ThemeOption) =>
    !q || t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)
  const builtin = BUILTIN_THEMES.filter(match)
  const shiki = SHIKI_THEMES.filter(match)
  const firstMatch = builtin[0] ?? shiki[0]

  const select = (id: string) => {
    onChange(id)
    setOpen(false)
  }

  // On open, bring the current theme into view within the list only (never the
  // page), so opening the picker doesn't jump the layout.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const renderItem = (theme: ThemeOption) => {
    const active = theme.id === value
    return (
      <button
        key={theme.id}
        type="button"
        data-active={active}
        onClick={() => select(theme.id)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
          active && 'bg-accent/60',
        )}
      >
        <span className="truncate">{theme.label}</span>
        {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setQuery('')
        }}
      >
        <Popover.Trigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-[168px] justify-between font-normal"
            aria-label="Diagram theme"
          >
            <span className="truncate">{current?.label ?? 'Theme'}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
            onOpenAutoFocus={(e) => {
              // Focus the search field ourselves and skip Radix's default focus
              // (which can nudge the scroll position).
              e.preventDefault()
              inputRef.current?.focus()
            }}
          >
            <div className="p-1">
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && firstMatch) {
                    e.preventDefault()
                    select(firstMatch.id)
                  }
                }}
                placeholder="Search themes…"
                className="h-8"
                aria-label="Search themes"
              />
            </div>
            <div ref={listRef} className="max-h-72 overflow-auto">
              {!firstMatch ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No themes found.
                </p>
              ) : (
                <>
                  {builtin.length ? (
                    <div>
                      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        Built-in
                      </p>
                      {builtin.map(renderItem)}
                    </div>
                  ) : null}
                  {shiki.length ? (
                    <div>
                      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                        VS Code / Shiki
                      </p>
                      {shiki.map(renderItem)}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {loading ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
    </div>
  )
}
