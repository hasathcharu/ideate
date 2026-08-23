'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  OctagonAlert,
  Plug,
  RefreshCw,
  ServerCrash,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { AgentLinkStatus } from '@/lib/agentLink'
import { DEFAULT_MCP_ORIGIN, REPO_URL } from '@/lib/config'
import { normalizeMcpOrigin, validateMcpOrigin } from '@/lib/mcpOrigin'

/**
 * Turning Agent Link on and off, and handing over the pairing code.
 *
 * Its own modal rather than a row in the diagram-config dialog: it has nothing to
 * do with diagrams, and it applies to all three document kinds. And a modal rather
 * than a plain toolbar toggle because switching this on lets a process outside the
 * browser rewrite whatever document is open — that deserves reading a sentence
 * first, not one click on a button.
 *
 * There are **two copyable things in the open and their order is deliberate**: the
 * pairing code comes first, because it is what the human does every session and what
 * they change to point an agent at a different tab. The setup command comes second,
 * because it is run once and then never again. The third — the command that runs a
 * service of your own — sits inside Advanced options, beside the field that points
 * this tab at the result.
 *
 * "Waiting" remains the ordinary resting state rather than a fault — the service is
 * shared and always up, but no agent has claimed this tab until one decides to.
 */

/** Where a self-hoster is sent from the capacity message. */
const SELF_HOST_DOCS = `${REPO_URL}/blob/main/ideate-mcp/README.md`

/** Running a service of your own, in one line. The published image is the whole
 *  answer — the binary needs no configuration and keeps nothing on disk — so the
 *  command belongs *here*, beside the field it exists to fill in, rather than only
 *  behind the docs link. */
const MCP_DOCKER_COMMAND =
  'docker run --rm -p 7391:7391 hasathcharu/ideate-mcp'

export interface AgentLinkModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  status: AgentLinkStatus
  detail: string | null
  agent: string | null
  /** This tab's pairing code, already grouped as `XXXX-XXXX`. */
  code: string
  onRegenerate: () => void
  onRetry: () => void
  /** The origin actually in use — the stored override, or the default. */
  mcpOrigin: string
  /** Null resets to `DEFAULT_MCP_ORIGIN`. */
  onMcpOriginChange: (origin: string | null) => void
  mode: 'github' | 'local'
}

export default function AgentLinkModal({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
  status,
  detail,
  agent,
  code,
  onRegenerate,
  onRetry,
  mcpOrigin,
  onMcpOriginChange,
  mode,
}: AgentLinkModalProps) {
  const setupCommand = `claude mcp add --transport http ideate ${mcpOrigin}/mcp`
  // Held here rather than in `CopyButton` so the fallback can select the text the
  // user is actually looking at.
  const codeRef = useRef<HTMLElement | null>(null)
  const commandRef = useRef<HTMLElement | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-4" /> Agent Link
          </DialogTitle>
          <DialogDescription>
            Let a coding agent — anything that speaks MCP — read and edit the document open
            in this tab.
          </DialogDescription>
        </DialogHeader>

        {/* The body scrolls, the header and footer do not: this dialog is taller than
            a short viewport (and than a laptop's, with Advanced options open), and a
            `DialogContent` that overflows is clipped by the viewport rather than
            scrolled — the Done button goes off-screen with no way to reach it.
            `min-h-0` is what lets this flex item shrink below its content so
            `overflow-y-auto` has something to do.

            `min-w-0` is load-bearing for the other axis: the long setup command in
            the <pre> below stretched the column past the dialog, and `DialogFooter`'s
            `-mx-4` bleed then landed its edges outside the modal. Allowing this item
            to shrink is what lets the <pre> scroll instead of pushing. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto text-sm">
          <p className="text-muted-foreground">
            Edits arrive as ordinary undoable changes, and the agent gets the renderer’s
            verdict back so it can fix its own mistakes.{' '}
            <span className="text-foreground">Nothing is ever committed</span> — the most an
            agent can touch is the working copy in front of you.
          </p>

          <p className="text-xs text-muted-foreground">
            This tab and the service carry a protocol version and refuse to talk on a
            mismatch. If your agent reports one, reload this tab and update the service.
          </p>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <Label htmlFor="agent-link" className="cursor-pointer">
              {enabled ? 'On' : 'Off'}
            </Label>
            <Switch id="agent-link" checked={enabled} onCheckedChange={onEnabledChange} />
          </div>

          {enabled ? (
            <>
              <PairingCode
                code={code}
                codeRef={codeRef}
                onRegenerate={onRegenerate}
                disabled={status === 'off'}
              />
              <Status status={status} detail={detail} agent={agent} onRetry={onRetry} />
            </>
          ) : null}

          <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <p className="mb-2">
              One-time setup: register Ideate as an MCP server in your agent. Run it once —
              after that only the pairing code changes.
            </p>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-background p-2 font-mono text-foreground">
                <code ref={commandRef}>{setupCommand}</code>
              </pre>
              <CopyButton text={setupCommand} target={commandRef} label="setup command" />
            </div>
            <p className="mt-2">
              Other clients: an HTTP (streamable) MCP server at{' '}
              <code className="text-foreground">{mcpOrigin}/mcp</code>.
            </p>
            <p className="mt-2">
              Give your agent the code when you ask it for something. Naming a different tab’s
              code switches which tab it drives — nothing to reconfigure.
            </p>
            {mode === 'local' ? (
              <p className="mt-2">
                <span className="font-medium text-foreground">In local mode</span> your
                document is not in a repository, but it still travels through the service to
                reach your agent while this is on.
              </p>
            ) : null}
          </div>

          <AdvancedOptions mcpOrigin={mcpOrigin} onChange={onMcpOriginChange} />
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
 * The code, big enough to read off the screen to somebody.
 *
 * `tracking-widest` and a monospace face are not decoration: this is a string that
 * gets transcribed, and the Crockford alphabet's whole purpose (no I, L, O or U) is
 * defeated if the glyphs are ambiguous anyway.
 */
function PairingCode({
  code,
  codeRef,
  onRegenerate,
  disabled,
}: {
  code: string
  codeRef: RefObject<HTMLElement | null>
  onRegenerate: () => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">This tab’s pairing code</Label>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={onRegenerate}
          disabled={disabled}
          title="Mint a new code. The old one stops working immediately."
        >
          <RefreshCw className="size-3.5" /> Regenerate
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <code
          ref={codeRef}
          className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xl tracking-widest text-foreground"
        >
          {code || '········'}
        </code>
        <CopyButton text={code} target={codeRef} label="pairing code" />
      </div>
    </div>
  )
}

/**
 * Advanced options, behind a disclosure because almost nobody needs them — and
 * directly below the capacity message, because "run your own" and the field that
 * points at it should not be in different parts of the dialog.
 *
 * A native `<details>` rather than a Radix collapsible: it is one toggle with no
 * state to coordinate, and the element already does the keyboard and ARIA work.
 */
function AdvancedOptions({
  mcpOrigin,
  onChange,
}: {
  mcpOrigin: string
  onChange: (origin: string | null) => void
}) {
  const [draft, setDraft] = useState(mcpOrigin)
  const dockerRef = useRef<HTMLElement | null>(null)
  // Adopt an origin changed from elsewhere (a reset, another tab writing config)
  // rather than stranding the field on a stale value.
  useEffect(() => setDraft(mcpOrigin), [mcpOrigin])

  const trimmed = normalizeMcpOrigin(draft)
  const error = trimmed === mcpOrigin ? null : validateMcpOrigin(draft)
  const dirty = trimmed !== mcpOrigin

  const apply = () => {
    const message = validateMcpOrigin(draft)
    if (message) return
    onChange(trimmed === normalizeMcpOrigin(DEFAULT_MCP_ORIGIN) ? null : trimmed)
  }

  return (
    <details className="group rounded-lg border px-3 py-2 text-xs">
      <summary className="cursor-pointer list-none text-muted-foreground marker:content-none hover:text-foreground">
        Advanced options
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <Label htmlFor="mcp-origin" className="text-xs text-muted-foreground">
          Agent Link service
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="mcp-origin"
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 font-mono text-xs"
            placeholder={DEFAULT_MCP_ORIGIN}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply()
            }}
          />
          <Button size="sm" className="h-8" onClick={apply} disabled={!dirty || !!error}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setDraft(DEFAULT_MCP_ORIGIN)
              onChange(null)
            }}
            disabled={mcpOrigin === normalizeMcpOrigin(DEFAULT_MCP_ORIGIN)}
          >
            Reset
          </Button>
        </div>
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : (
          <p className="text-muted-foreground">
            Point this tab at a service you run yourself. https anywhere, or http on{' '}
            <code>localhost:7391</code> — the code and your document travel over it.
          </p>
        )}
        <p className="text-muted-foreground">Run one locally:</p>
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-foreground">
            <code ref={dockerRef}>{MCP_DOCKER_COMMAND}</code>
          </pre>
          <CopyButton text={MCP_DOCKER_COMMAND} target={dockerRef} label="docker command" />
        </div>
        <a
          href={SELF_HOST_DOCS}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Configuration and self-hosting notes
        </a>
      </div>
    </details>
  )
}

/**
 * Copy `text`, with a fallback, because the async Clipboard API is refused more
 * often than it looks: it needs a secure context *and* transient user activation,
 * and some embedded or automated browsers decline it outright even then. A copy
 * button that silently does nothing is worse than no button, so this tries three
 * things in descending order of niceness and only claims success when one worked.
 *
 * The last resort is not a failure message but a **selection** of the visible text,
 * so ⌘C finishes the job the button started.
 */
async function copyText(text: string, target: HTMLElement | null): Promise<'copied' | 'selected'> {
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    /* fall through */
  }

  // `execCommand` is deprecated but still the widest-supported path, and unlike
  // the async API it works from a plain click with no permission prompt.
  const scratch = document.createElement('textarea')
  scratch.value = text
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
function CopyButton({
  text,
  target,
  label,
}: {
  text: string
  target: RefObject<HTMLElement | null>
  label: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="mt-0.5 flex-none"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      disabled={!text}
      onClick={async () => {
        const outcome = await copyText(text, target.current)
        if (outcome === 'copied') {
          setCopied(true)
          toast.success(`Copied ${label}`)
          window.setTimeout(() => setCopied(false), 1500)
        } else {
          toast.info(`Selected the ${label} — press ⌘C to copy.`)
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
  onRetry,
}: {
  status: AgentLinkStatus
  detail: string | null
  agent: string | null
  onRetry: () => void
}) {
  if (status === 'attached') {
    return (
      <p className="flex items-center gap-2 text-sm text-primary">
        <CheckCircle2 className="size-4 flex-none" />
        {agent ?? 'An agent'} is attached and can edit this document.
      </p>
    )
  }
  // Paired but unclaimed. Worth spelling out, because "on but nothing can touch
  // your document yet" is the state people would otherwise misread as broken.
  if (status === 'paired') {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Plug className="mt-0.5 size-4 flex-none" />
        <span className="min-w-0 wrap-break-word">
          This tab is ready. Give your agent the code above and ask it to connect — nothing
          can read or edit this document until it does.
        </span>
      </p>
    )
  }
  // Capacity gets real copy rather than a generic failure, because there is
  // something specific and achievable to do about it, and Advanced options — the
  // field that does it — is directly below.
  if (status === 'full') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <ServerCrash className="mt-0.5 size-4 flex-none text-destructive" />
        <div className="flex min-w-0 flex-col items-start gap-2">
          <span className="wrap-break-word">
            The shared Agent Link service is at capacity. Run your own — one container — and
            point this tab at it in Advanced options.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRetry}>
              Retry
            </Button>
            <a
              href={SELF_HOST_DOCS}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              How to run your own
            </a>
          </div>
        </div>
      </div>
    )
  }
  if (status === 'blocked') {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <OctagonAlert className="mt-0.5 size-4 flex-none" />
        <span className="min-w-0 wrap-break-word">{detail ?? 'The connection was refused.'}</span>
      </p>
    )
  }
  // Deliberately not styled as an error: a service restart or a flaky network is
  // an ordinary thing to be in the middle of.
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Loader2 className="mt-0.5 size-4 flex-none animate-spin" />
      <span className="min-w-0 wrap-break-word">
        {detail ?? 'Connecting to the Agent Link service…'}
      </span>
    </p>
  )
}
