'use client'

import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'

export interface AppLayoutProps {
  header: ReactNode
  sidebar: ReactNode
  showSidebar: boolean
  sidebarWidth: number
  minSidebarWidth: number
  maxSidebarWidth: number
  onSidebarPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onSidebarKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
  dialogs: ReactNode
}

/** Structural shell only: header, optional navigation, document pane, and overlays. */
export default function AppLayout({
  header,
  sidebar,
  showSidebar,
  sidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  onSidebarPointerDown,
  onSidebarKeyDown,
  children,
  dialogs,
}: AppLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {header}
      <div className="flex min-h-0 flex-1">
        {sidebar}
        {showSidebar ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={minSidebarWidth}
            aria-valuemax={maxSidebarWidth}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={onSidebarPointerDown}
            onKeyDown={onSidebarKeyDown}
            className="group flex w-1.5 flex-none cursor-col-resize touch-none items-center justify-center bg-border transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
          >
            <div className="h-8 w-0.5 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
          </div>
        ) : null}
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      {dialogs}
    </div>
  )
}
