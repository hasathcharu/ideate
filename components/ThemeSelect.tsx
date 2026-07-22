'use client'

import { Loader2 } from 'lucide-react'
import { BUILTIN_THEMES, SHIKI_THEMES } from '@/lib/themes'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface ThemeSelectProps {
  value: string
  onChange: (id: string) => void
  loading?: boolean
}

export default function ThemeSelect({ value, onChange, loading }: ThemeSelectProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-[168px]" aria-label="Diagram theme">
          <SelectValue placeholder="Theme" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Built-in</SelectLabel>
            {BUILTIN_THEMES.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectGroup>
            <SelectLabel>VS Code / Shiki</SelectLabel>
            {SHIKI_THEMES.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {loading ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
      ) : null}
    </div>
  )
}
