'use client'

import { useRef, useState, type RefObject } from 'react'
import { Check, CheckCircle2, Copy, Loader2, OctagonAlert, Plug } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AgentLinkStatus } from '@/lib/agentLink'

/**
 * Turning Agent Link on and off.
 *
 * Its own modal rather than a row in the diagram-config dialog: it has nothing to
 * do with diagrams, and it applies to all three document kinds. And a modal rather
 * than a plain toolbar toggle because switching this on hands a process outside the
 * browser the ability to rewrite whatever document is open — that deserves reading
 * a sentence first, not one click on a button.
 *
 * Once it is on, this is also where the connection state is explained. "Waiting" is
 * the ordinary resting state, not a fault: the socket belongs to the agent's
 * process, which starts and stops with an agent session while this tab stays open.
 *
 * The setup is shown as one copyable command rather than a command/args table.
 * The table was harness-agnostic and technically more honest, but it made everyone
 * translate it by hand for the sake of the minority whose client wants the parts
 * separately — so the common case gets the one-liner, and the parts are spelled out
 * underneath for the clients that need them.
 */

/** What most people need, and the reason there is a copy button at all. */
const SETUP_COMMAND = 'claude mcp add ideate -- npx -y github:hasathcharu/ideate'

export interface AgentLinkModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  status: AgentLinkStatus
  detail: string | null
  agent: string | null
}

export default function AgentLinkModal({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
  status,
  detail,
  agent,
}: AgentLinkModalProps) {
  // Held here rather than in `CopyButton` so the fallback can select the command
  // the user is actually looking at.
  const commandRef = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-4" /> Agent Link
            <Badge variant="secondary">Beta</Badge>
          </DialogTitle>
          <DialogDescription>
            Let a coding agent — Claude Code, Cursor, anything that speaks MCP — read and
            edit the document open in this tab.
          </DialogDescription>
        </DialogHeader>

        {/* `min-w-0` is load-bearing. `DialogContent` is a CSS grid, so a grid item
            defaults to its max-content width — the long setup command in the <pre>
            below stretched the column past the dialog, and `DialogFooter`'s `-mx-4`
            bleed then landed its edges outside the modal. Allowing this item to
            shrink is what lets the <pre> scroll instead of pushing. */}
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            Edits arrive in the editor as you watch, as ordinary undoable changes, and the
            agent gets the renderer’s verdict back so it can fix its own mistakes.{' '}
            <span className="text-foreground">Nothing is ever committed</span> — saving stays
            yours, so the most an agent can touch is the working copy in front of you.
          </p>

          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Beta.</span> The tools and the
            protocol between the app and the MCP server can still change between versions.
            If your agent reports a protocol mismatch, update whichever side is older —
            they refuse to talk rather than guess.
          </p>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <Label htmlFor="agent-link" className="cursor-pointer">
              {enabled ? 'On' : 'Off'}
            </Label>
            <Switch id="agent-link" checked={enabled} onCheckedChange={onEnabledChange} />
          </div>

          {enabled ? <Status status={status} detail={detail} agent={agent} /> : null}

          <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <p className="mb-2">
              Register Ideate as an MCP server in your agent. In Claude Code, that is one
              command:
            </p>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-background p-2 font-mono text-foreground">
                <code ref={commandRef}>{SETUP_COMMAND}</code>
              </pre>
              <CopyButton commandRef={commandRef} />
            </div>
            <p className="mt-2">
              Other clients — Cursor, Windsurf, Zed, Claude Desktop — read the same thing
              from a JSON config, as command <code className="text-foreground">npx</code> with
              args <code className="text-foreground">-y github:hasathcharu/ideate</code>.
            </p>
            <p className="mt-2">
              Either way it finds this tab on its own — no port and no token to copy. Only
              pages served from this Ideate origin can connect, and each connection carries a
              single-use signed token, so another site open in your browser cannot take the
              socket.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Copy the setup command, with a fallback, because the async Clipboard API is
 * refused more often than it looks: it needs a secure context *and* transient user
 * activation, and some embedded or automated browsers decline it outright even
 * then. A copy button that silently does nothing is worse than no button, so this
 * tries three things in descending order of niceness and only claims success when
 * one actually worked.
 *
 * The last resort is not a failure message but a **selection** of the command text,
 * so ⌘C finishes the job the button started.
 */
async function copyCommand(target: HTMLElement | null): Promise<'copied' | 'selected'> {
  try {
    await navigator.clipboard.writeText(SETUP_COMMAND)
    return 'copied'
  } catch {
    /* fall through */
  }

  // `execCommand` is deprecated but still the widest-supported path, and unlike
  // the async API it works from a plain click with no permission prompt.
  const scratch = document.createElement('textarea')
  scratch.value = SETUP_COMMAND
  // Off-screen rather than `display: none`: a hidden element cannot be selected,
  // which is the one thing this needs to do.
  scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(scratch)
  scratch.select()
  try {
    if (document.execCommand('copy')) return 'copied'
  } catch {
    /* fall through */
  } finally {
    scratch.remove()
  }

  // Nothing could write to the clipboard. Select the visible command so the user
  // only has to press ⌘C.
  if (target) {
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  return 'selected'
}

/** Mirrors the copy affordance in `ExportMenu`: a ghost icon button and a toast,
 *  with a moment of acknowledgement on the icon itself so the click is not silent. */
function CopyButton({ commandRef }: { commandRef: RefObject<HTMLElement | null> }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="mt-0.5 flex-none"
      aria-label="Copy setup command"
      title="Copy setup command"
      onClick={async () => {
        const outcome = await copyCommand(commandRef.current)
        if (outcome === 'copied') {
          setCopied(true)
          toast.success('Command copied')
          window.setTimeout(() => setCopied(false), 1500)
        } else {
          toast.info('Selected the command — press ⌘C to copy.')
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

function Status({
  status,
  detail,
  agent,
}: {
  status: AgentLinkStatus
  detail: string | null
  agent: string | null
}) {
  if (status === 'attached') {
    return (
      <p className="flex items-center gap-2 text-sm text-primary">
        <CheckCircle2 className="size-4 flex-none" />
        {agent ?? 'An agent'} is attached and can edit this document.
      </p>
    )
  }
  // Linked but unclaimed. Worth spelling out, because "on but nothing can touch
  // your document yet" is the state people would otherwise misread as broken.
  if (status === 'linked') {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Plug className="mt-0.5 size-4 flex-none" />
        <span className="min-w-0 wrap-break-word">
          An agent is running but has not attached. Nothing can read or edit this document
          until it does — ask it to connect to Ideate.
        </span>
      </p>
    )
  }
  if (status === 'blocked') {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <OctagonAlert className="mt-0.5 size-4 flex-none" />
        <span className="min-w-0 wrap-break-word">{detail ?? 'The bridge was refused.'}</span>
      </p>
    )
  }
  // Deliberately not styled as an error: with no agent session running there is
  // nothing to connect to, and that is most of the time.
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Loader2 className="mt-0.5 size-4 flex-none animate-spin" />
      <span className="min-w-0 wrap-break-word">
        {detail ?? 'Waiting for an agent to start. This tab keeps trying in the background.'}
      </span>
    </p>
  )
}
