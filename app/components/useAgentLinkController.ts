'use client'

import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import type { EditorHandle } from './Editor'
import type { MarkdownPreviewHandle } from './MarkdownPreview'
import { useAgentLink, type AgentLink, type AgentLinkCapabilities } from '@/lib/agentLink'
import type {
  BridgeState,
  Diagnostic,
  PatchConflict,
  ReadManyRequest,
  RevisionExpectation,
} from '@/lib/agentProtocol'
import {
  AGENT_MAX_MANIFEST_FILES,
  AGENT_MAX_READ_MANY_BYTES,
  AGENT_MAX_READ_MANY_PATHS,
  AGENT_MAX_SEARCH_BYTES,
  PatchHunkError,
  applyFilePatch,
  assertPatchableKind,
  lineRange,
  matchesPathGlobs,
  parseUnifiedDiff,
  searchDocuments,
} from '@/lib/agentWorkspace'
import { collectDiagnostics } from '@/lib/diagnostics'
import { draftBaseFor, draftNeedsReconciliation } from '@/lib/draftLifecycle'
import { EMPTY_SCENE, scenesEqual } from '@/lib/excalidraw'
import { renderSceneThumbnail } from '@/lib/exportScene'
import { normalizeMcpOrigin } from '@/lib/mcpOrigin'
import { applySceneOps, summarizeScene } from '@/lib/sceneEdit'
import {
  clearDraft,
  createDraftResult,
  readDraftResult,
  readLocalFileResult,
  writeDraftResult,
  writeDraftBatchResult,
  type DraftBaseRevision,
} from '@/lib/storage'
import { applyResolved, resolveEdits } from '@/lib/textEdit'
import { fileKind, type FileKind } from '@/lib/tree'
import {
  documentKey,
  workspaceKey,
  type DocumentIdentity,
  type WorkspaceStore,
} from '@/lib/workspaceStore'
import type { MermaidUserConfig } from '@/lib/mermaidConfig'
import type { RepoRef } from '@/lib/types'

type SavedRead =
  | { ok: true; content: string; sha: string }
  | { ok: false; message: string; expired: boolean }

interface AgentLinkControllerOptions {
  enabled: boolean
  configuredOrigin: string | null
  defaultOrigin: string
  githubEnabled: boolean
  repo: RepoRef | null
  openPath: string | null
  kind: FileKind
  dirty: boolean
  text: string
  currentTheme: string
  noneThemeValue: string
  customThemeValue: string
  canvasTheme: 'light' | 'dark'
  hasWorkspace: boolean
  localMode: boolean
  savedPaths: ReadonlySet<string> | null
  pendingPaths: ReadonlySet<string>
  repoFilePaths: readonly string[]
  loadedSha: string | null
  baseline: string
  activeDocId: string
  appliedConfig: MermaidUserConfig | null
  workspaceStore: WorkspaceStore
  openPathRef: React.RefObject<string | null>
  activeIdentityRef: React.RefObject<DocumentIdentity>
  liveTextRef: React.RefObject<string>
  workspaceSelectionRef: React.RefObject<string>
  draftBasesRef: React.RefObject<Map<string, DraftBaseRevision>>
  identityFor: (path: string | null, scratchKind?: FileKind) => DocumentIdentity
  docIdForPath: (path: string) => string
  readSaved: (path: string) => Promise<SavedRead>
  validatePath: (path: string) => string | null
  templateFor: (kind: FileKind) => string
  setText: (text: string) => void
  setOpenPath: (path: string | null) => void
  setLoadedSha: (sha: string | null) => void
  setBaseline: (content: string) => void
  setCreatedPaths: Dispatch<SetStateAction<ReadonlySet<string>>>
  setDirtyPaths: Dispatch<SetStateAction<ReadonlySet<string>>>
  setLinkTrail: Dispatch<SetStateAction<string[]>>
  openFile: (path: string) => Promise<boolean>
  flushOutgoingDraft: () => Promise<boolean>
}

export interface AgentLinkController {
  editorRef: React.RefObject<EditorHandle | null>
  markdownPreviewRef: React.RefObject<MarkdownPreviewHandle | null>
  revealInPreview: (line: number) => void
  revealInEditor: (line: number) => void
  mcpOrigin: string
  agentLink: AgentLink
  linkAttached: boolean
  linkWaiting: boolean
}

interface DocTarget {
  path: string | null
  kind: FileKind
  text: string
  committed: string | null
  open: boolean
  created: boolean
  identity: DocumentIdentity
  revision: number
  draftBase: DraftBaseRevision
}

interface PreparedPatchChange {
  target: DocTarget
  text: string
  added: number
  deleted: number
  diagnostics: Diagnostic[]
}

function contentDiffers(a: string, b: string, kind: FileKind): boolean {
  return kind === 'excalidraw' ? !scenesEqual(a, b) : a !== b
}

function withoutPaths(set: ReadonlySet<string>, paths: readonly string[]): ReadonlySet<string> {
  if (!paths.some((path) => set.has(path))) return set
  const next = new Set(set)
  for (const path of paths) next.delete(path)
  return next
}

function withPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (set.has(path)) return set
  const next = new Set(set)
  next.add(path)
  return next
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The operation failed.'
}

function conflictExcerpt(text: string, line = 1): string {
  const lines = text.split('\n')
  const from = Math.max(0, line - 3)
  return lines.slice(from, from + 5).map((value, offset) => `${from + offset + 1}: ${value}`).join('\n')
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await map(values[index]!)
    }
  }))
  return results
}

function requireText(target: FileKind): void {
  if (target === 'excalidraw') {
    throw new Error(
      'That document is an Excalidraw scene. Use ideate_scene_get and ' +
        'ideate_scene_edit — the text tools cannot edit a canvas.',
    )
  }
}

function requireScene(target: FileKind): void {
  if (target !== 'excalidraw') {
    throw new Error(
      `That document is ${target}, not an Excalidraw scene. Use ideate_read and ` +
        'ideate_edit instead.',
    )
  }
}

/** Adapts ordered working-copy commands to the Agent Link capability surface. */
export function useAgentLinkController(options: AgentLinkControllerOptions): AgentLinkController {
  const {
    enabled,
    configuredOrigin,
    defaultOrigin,
    githubEnabled,
    repo,
    openPath,
    kind,
    dirty,
    text,
    currentTheme,
    noneThemeValue,
    customThemeValue,
    canvasTheme,
    hasWorkspace,
    localMode,
    savedPaths,
    pendingPaths,
    repoFilePaths,
    loadedSha,
    baseline,
    activeDocId,
    appliedConfig,
    workspaceStore,
    openPathRef,
    activeIdentityRef,
    liveTextRef,
    workspaceSelectionRef,
    draftBasesRef,
    identityFor,
    docIdForPath,
    readSaved,
    validatePath,
    templateFor,
    setText,
    setOpenPath,
    setLoadedSha,
    setBaseline,
    setCreatedPaths,
    setDirtyPaths,
    setLinkTrail,
    openFile,
    flushOutgoingDraft,
  } = options

  const editorRef = useRef<EditorHandle | null>(null)
  const markdownPreviewRef = useRef<MarkdownPreviewHandle | null>(null)
  const revealInPreview = useCallback((line: number) => markdownPreviewRef.current?.revealLine(line), [])
  const revealInEditor = useCallback((line: number) => editorRef.current?.revealLine(line), [])

  const bridgeState: BridgeState = useMemo(() => ({
    mode: githubEnabled ? 'github' : 'local',
    repo: repo
      ? { owner: repo.owner, name: repo.name, branch: repo.branch, defaultBranch: repo.defaultBranch }
      : null,
    openPath,
    kind,
    dirty,
    lineCount: text === '' ? 0 : text.split('\n').length,
    charCount: text.length,
    theme: {
      name: currentTheme === noneThemeValue ? null : currentTheme === customThemeValue ? 'custom' : currentTheme,
      mode: canvasTheme,
    },
  }), [
    githubEnabled,
    repo,
    openPath,
    kind,
    dirty,
    text,
    currentTheme,
    noneThemeValue,
    customThemeValue,
    canvasTheme,
  ])

  const workspaceLabel = repo ? `${repo.owner}/${repo.name}@${repo.branch}` : 'this browser'

  const resolveTarget = async (path: string | undefined, create: boolean): Promise<DocTarget> => {
    if (path === undefined || path === openPathRef.current) {
      const identity = activeIdentityRef.current
      const record = workspaceStore.get(documentKey(identity)) ?? workspaceStore.ensure(
        identity,
        liveTextRef.current,
        loadedSha === null ? '' : baseline,
        loadedSha,
      )
      return {
        path: openPathRef.current,
        kind: identity.kind,
        text: record?.content ?? liveTextRef.current,
        committed: record
          ? record.savedRevision === null ? null : record.savedContent
          : loadedSha === null ? null : baseline,
        open: true,
        created: false,
        identity,
        revision: record.revision,
        draftBase: draftBasesRef.current.get(activeDocId) ?? draftBaseFor(record.savedRevision),
      }
    }
    if (!hasWorkspace) {
      throw new Error(
        'This tab has no file workspace: the human is signed in and has picked no ' +
          'repository, so there is nothing a path can name — only one untitled ' +
          'document, reached by omitting the path. Ask them to connect a repository ' +
          'if you need files.',
      )
    }
    const invalid = validatePath(path)
    if (invalid) throw new Error(`${path}: ${invalid}`)
    if (!savedPaths) throw new Error('The file list has not loaded yet. Try again in a moment.')

    const targetKind = fileKind(path)
    const identity = identityFor(path)
    const cached = workspaceStore.get(documentKey(identity))
    if (cached) {
      return {
        path,
        kind: targetKind,
        text: cached.content,
        committed: cached.savedRevision === null ? null : cached.savedContent,
        open: false,
        created: false,
        identity: cached.identity,
        revision: cached.revision,
        draftBase: draftBasesRef.current.get(docIdForPath(path)) ?? draftBaseFor(cached.savedRevision),
      }
    }

    const draftResult = await readDraftResult(docIdForPath(path))
    if (draftResult.status === 'invalid' || draftResult.status === 'unavailable') {
      throw new Error(`${path}'s draft is ${draftResult.status}; it was not replaced.`)
    }
    const draft = draftResult.status === 'ok' ? draftResult.value : null
    if (savedPaths.has(path)) {
      const res = await readSaved(path)
      if (!res.ok) {
        throw new Error(res.expired ? 'The GitHub session expired. The user has been signed out.' : res.message)
      }
      const differs = draft !== null && contentDiffers(draft.content, res.content, targetKind)
      if (differs && draft && draftNeedsReconciliation(draft.baseRevision, res.sha)) {
        throw new Error(`${path}'s draft is based on an older or unknown revision. Open it to reconcile first.`)
      }
      if (draft) draftBasesRef.current.set(docIdForPath(path), draft.baseRevision)
      const working = differs && draft ? draft.content : res.content
      const record = workspaceStore.ensure(identity, working, res.content, res.sha)
      return {
        path,
        kind: targetKind,
        text: working,
        committed: res.content,
        open: false,
        created: false,
        identity,
        revision: record.revision,
        draftBase: draft?.baseRevision ?? draftBaseFor(res.sha),
      }
    }
    if (draft) {
      const record = workspaceStore.ensure(identity, draft.content, '', null)
      return {
        path,
        kind: targetKind,
        text: draft.content,
        committed: null,
        open: false,
        created: false,
        identity,
        revision: record.revision,
        draftBase: draft.baseRevision,
      }
    }
    if (pendingPaths.has(path)) {
      const record = workspaceStore.ensure(identity, '', '', null)
      return {
        path,
        kind: targetKind,
        text: '',
        committed: null,
        open: false,
        created: false,
        identity,
        revision: record.revision,
        draftBase: { status: 'absent' },
      }
    }
    if (!create) {
      throw new Error(`No such file in ${workspaceLabel}: ${path}. Call ideate_list_files to see what is there.`)
    }
    return {
      path,
      kind: targetKind,
      text: templateFor(targetKind),
      committed: null,
      open: false,
      created: true,
      identity,
      revision: workspaceStore.get(documentKey(identity))?.revision ?? 0,
      draftBase: { status: 'absent' },
    }
  }

  const writeBack = async (target: DocTarget, next: string): Promise<void> => {
    if (target.open && workspaceStore.isActive(documentKey(target.identity))) {
      const actual = workspaceStore.get(documentKey(target.identity))?.revision ?? 0
      if (actual !== target.revision) throw new Error('Document changed during the command. Retry.')
      setText(next)
      return
    }
    if (target.path === null) throw new Error('The untitled document was closed during the command. Retry.')
    if ((workspaceStore.get(documentKey(target.identity))?.revision ?? 0) !== target.revision) {
      throw new Error('Document changed during the command. Retry.')
    }
    const isDirty = target.committed === null || contentDiffers(next, target.committed, target.kind)
    const id = docIdForPath(target.path)
    const base = draftBasesRef.current.get(id) ?? target.draftBase
    if (isDirty) draftBasesRef.current.set(id, base)
    const persisted = await (isDirty ? writeDraftResult(id, next, base) : clearDraft(id))
    if (!persisted.ok) throw new Error(`Could not update ${target.path}'s draft: ${persisted.reason}.`)
    workspaceStore.editIfRevision(target.identity, target.revision, next)
    if (workspaceKey(target.identity.workspace) === workspaceSelectionRef.current) {
      if (target.created) setCreatedPaths((prev) => withPath(prev, target.path!))
      setDirtyPaths((prev) => isDirty ? withPath(prev, target.path!) : withoutPaths(prev, [target.path!]))
    }
  }

  const requirePath = (path: string | undefined, tool: string): void => {
    if (path !== undefined || openPathRef.current === null) return
    throw new Error(
      `${tool} needs a path. ${openPathRef.current} is open, but the open document changes as ` +
        'the human browses — so an edit with no path can land on a file you never ' +
        'read. Name the file you mean: ideate_status reports the open path, ' +
        'ideate_list_files the rest.',
    )
  }

  const commandFor = <T,>(path: string | undefined, run: () => Promise<T>): Promise<T> => {
    const identity = path === undefined ? activeIdentityRef.current : identityFor(path)
    const workspace = workspaceSelectionRef.current
    return workspaceStore.command(identity, async () => {
      if (workspaceSelectionRef.current !== workspace) throw new Error('Workspace changed during the command. Retry.')
      if (path === undefined && documentKey(activeIdentityRef.current) !== documentKey(identity)) {
        throw new Error('Active document changed during the command. Retry with an explicit path.')
      }
      return run()
    })
  }

  const activateCreated = (path: string, body: string) => {
    setLinkTrail([])
    setCreatedPaths((prev) => withPath(prev, path))
    setOpenPath(path)
    setLoadedSha(null)
    setBaseline('')
    setText(body)
  }

  const pathExists = async (path: string): Promise<boolean> =>
    repoFilePaths.includes(path) ||
    pendingPaths.has(path) ||
    (localMode && (await readLocalFileResult(path)).status !== 'missing') ||
    (await readDraftResult(docIdForPath(path))).status !== 'missing'

  const workspacePaths = (): string[] => [...new Set([
    ...repoFilePaths,
    ...workspaceStore.list()
      .filter((record) => record.identity.path !== null &&
        workspaceKey(record.identity.workspace) === workspaceSelectionRef.current)
      .map((record) => record.identity.path!),
  ])].sort()

  // Rebuilt each render so every capability observes the current workspace snapshot.
  const caps: AgentLinkCapabilities = {
    state: () => bridgeState,
    listFiles: () => ({ paths: workspacePaths() }),
    manifest: async () => {
      const paths = workspacePaths()
      const selected = paths.slice(0, AGENT_MAX_MANIFEST_FILES)
      const files = await mapWithConcurrency(selected, 8, async (path) => {
        const target = await resolveTarget(path, false)
        return {
          path,
          kind: target.kind,
          size: new TextEncoder().encode(target.text).byteLength,
          revision: target.revision,
          dirty: target.committed === null || contentDiffers(target.text, target.committed, target.kind),
          created: target.committed === null && !savedPaths!.has(path),
        }
      })
      const identity = identityFor(selected[0] ?? '__manifest__.mmd').workspace
      return {
        workspace: workspaceSelectionRef.current,
        identity,
        activePath: openPathRef.current,
        files,
        truncated: paths.length > selected.length,
      }
    },
    search: async (query, options) => {
      const documents = []
      let loadedBytes = 0
      let sourceTruncated = false
      for (const path of workspacePaths()) {
        if (!matchesPathGlobs(path, options.globs ?? [])) continue
        const target = await resolveTarget(path, false)
        if (target.kind === 'excalidraw') continue
        const bytes = new TextEncoder().encode(target.text).byteLength
        if (loadedBytes + bytes > AGENT_MAX_SEARCH_BYTES) {
          sourceTruncated = true
          break
        }
        loadedBytes += bytes
        documents.push({ path, text: target.text, revision: target.revision })
      }
      const result = searchDocuments(documents, query, { ...options, globs: [] })
      return { ...result, truncated: result.truncated || sourceTruncated }
    },
    readMany: async (files: readonly ReadManyRequest[]) => {
      if (files.length === 0) throw new Error('files is empty.')
      if (files.length > AGENT_MAX_READ_MANY_PATHS) {
        throw new Error(`read_many accepts at most ${AGENT_MAX_READ_MANY_PATHS} paths.`)
      }
      const seen = new Set<string>()
      let responseBytes = 0
      let truncated = false
      const results = []
      for (const request of files) {
        if (seen.has(request.path)) {
          results.push({ path: request.path, ok: false, error: 'The path appears more than once.' })
          continue
        }
        seen.add(request.path)
        if (truncated) {
          results.push({ path: request.path, ok: false, error: 'The response byte limit was reached.' })
          continue
        }
        try {
          const target = await resolveTarget(request.path, false)
          requireText(target.kind)
          const range = lineRange(target.text, request.startLine, request.endLine)
          const bytes = new TextEncoder().encode(range.text).byteLength
          if (responseBytes + bytes > AGENT_MAX_READ_MANY_BYTES) {
            truncated = true
            results.push({ path: request.path, ok: false, error: 'The response byte limit was reached.' })
            continue
          }
          responseBytes += bytes
          results.push({
            path: request.path,
            ok: true,
            text: range.text,
            kind: target.kind,
            revision: target.revision,
            committed: target.committed !== null && !contentDiffers(target.text, target.committed, target.kind),
            startLine: range.startLine,
            endLine: range.endLine,
            lineCount: range.lineCount,
          })
        } catch (error) {
          results.push({ path: request.path, ok: false, error: errorMessage(error) })
        }
      }
      return { files: results, truncated }
    },
    applyPatch: async (workspace, patchText, expected: readonly RevisionExpectation[]) => {
      if (workspace !== workspaceSelectionRef.current) {
        throw new Error('Workspace changed since the manifest was read. Connect again before patching.')
      }
      const patches = parseUnifiedDiff(patchText)
      const paths = patches.map(({ path }) => path)
      const expectedByPath = new Map(expected.map((item) => [item.path, item.revision]))
      if (expectedByPath.size !== expected.length || expected.length !== paths.length ||
          paths.some((path) => !expectedByPath.has(path)) || expected.some((item) => !paths.includes(item.path))) {
        throw new Error('expected must name every patched path exactly once, and no other path.')
      }
      const identities = paths.map((path) => identityFor(path))
      return workspaceStore.commandMany(identities, async () => {
        if (workspace !== workspaceSelectionRef.current) {
          throw new Error('Workspace changed during the patch. Retry against a fresh manifest.')
        }
        const targets: DocTarget[] = []
        const conflicts: PatchConflict[] = []
        for (const filePatch of patches) {
          const target = await resolveTarget(filePatch.path, true)
          assertPatchableKind(filePatch.path, target.kind)
          const actual = target.created ? 'absent' : target.revision
          const wanted = expectedByPath.get(filePatch.path)!
          if (wanted !== actual || (filePatch.oldPath === null) !== target.created) {
            conflicts.push({
              path: filePatch.path,
              expected: wanted,
              revision: actual,
              excerpt: conflictExcerpt(target.text),
              message: actual === 'absent' ? 'The file is absent; rebase the patch as a creation.' :
                'The working revision changed; read the current content and rebase the patch.',
            })
          }
          targets.push(filePatch.oldPath === null && target.created ? { ...target, text: '' } : target)
        }
        if (conflicts.length > 0) return { applied: false, files: [], conflicts }

        const changed: PreparedPatchChange[] = []
        for (let index = 0; index < patches.length; index += 1) {
          const target = targets[index]!
          try {
            const applied = applyFilePatch(target.text, patches[index]!)
            const diagnostics = await collectDiagnostics(applied.text, target.kind, appliedConfig)
            changed.push({ target, ...applied, diagnostics })
          } catch (error) {
            const line = error instanceof PatchHunkError ? error.line : 1
            return {
              applied: false,
              files: [],
              conflicts: [{
                path: target.path!,
                expected: expectedByPath.get(target.path!)!,
                revision: target.created ? 'absent' : target.revision,
                excerpt: error instanceof PatchHunkError ? error.excerpt : conflictExcerpt(target.text, line),
                message: errorMessage(error),
              }],
            }
          }
        }

        const revisionConflicts = (): PatchConflict[] => changed.flatMap(({ target }) => {
          const current = workspaceStore.get(documentKey(target.identity))
          const actual = current?.revision ?? 0
          if (actual === target.revision) return []
          return [{
            path: target.path!,
            expected: expectedByPath.get(target.path!)!,
            revision: current ? current.revision : 'absent',
            excerpt: conflictExcerpt(current?.content ?? ''),
            message: 'The working copy changed while the patch was being checked. Read it again and rebase.',
          }]
        })
        const beforeWriteConflicts = revisionConflicts()
        if (beforeWriteConflicts.length > 0) {
          return { applied: false, files: [], conflicts: beforeWriteConflicts }
        }

        const persisted = await writeDraftBatchResult(changed.map(({ target, text: next }) => {
          const dirty = target.committed === null || contentDiffers(next, target.committed, target.kind)
          return {
            id: docIdForPath(target.path!),
            content: dirty ? next : null,
            baseRevision: draftBasesRef.current.get(docIdForPath(target.path!)) ?? target.draftBase,
          }
        }))
        if (!persisted.ok) throw new Error(`Could not persist the atomic patch: browser storage is ${persisted.reason}.`)

        const afterWriteConflicts = revisionConflicts()
        if (afterWriteConflicts.length > 0) {
          const restored = await writeDraftBatchResult(changed.map(({ target }) => {
            const current = workspaceStore.get(documentKey(target.identity))
            if (!current && target.created) return { id: docIdForPath(target.path!), content: null }
            const currentText = current?.content ?? target.text
            const dirty = target.committed === null || contentDiffers(currentText, target.committed, target.kind)
            return {
              id: docIdForPath(target.path!),
              content: dirty ? currentText : null,
              baseRevision: draftBasesRef.current.get(docIdForPath(target.path!)) ?? target.draftBase,
            }
          }))
          if (!restored.ok) throw new Error(
            `The document changed during patch persistence and its draft could not be restored: ${restored.reason}.`,
          )
          return { applied: false, files: [], conflicts: afterWriteConflicts }
        }

        const created: string[] = []
        const dirty: string[] = []
        const clean: string[] = []
        for (const change of changed) {
          const { target, text: next } = change
          const isDirty = target.committed === null || contentDiffers(next, target.committed, target.kind)
          if (target.created) created.push(target.path!)
          if (isDirty) dirty.push(target.path!)
          else clean.push(target.path!)
          if (target.open && workspaceStore.isActive(documentKey(target.identity))) {
            const handle = editorRef.current
            if (handle) handle.replaceText(next)
            else setText(next)
          } else workspaceStore.editIfRevision(target.identity, target.revision, next)
        }
        if (created.length > 0) setCreatedPaths((previous) => {
          const next = new Set(previous)
          for (const path of created) next.add(path)
          return next
        })
        setDirtyPaths((previous) => {
          const next = new Set(previous)
          for (const path of dirty) next.add(path)
          for (const path of clean) next.delete(path)
          return next
        })
        return {
          applied: true,
          files: changed.map(({ target, added, deleted, diagnostics }) => ({
            path: target.path!,
            revision: workspaceStore.get(documentKey(target.identity))!.revision,
            created: target.created,
            added,
            deleted,
            diagnostics,
          })),
          conflicts: [],
        }
      })
    },
    read: async (path) => {
      const target = await resolveTarget(path, false)
      return {
        path: target.path,
        text: target.text,
        kind: target.kind,
        revision: target.revision,
        committed: target.path !== null && target.committed !== null &&
          !contentDiffers(target.text, target.committed, target.kind),
      }
    },
    applyEdits: async (edits, path) => commandFor(path, async () => {
      requirePath(path, 'ideate_edit')
      const target = await resolveTarget(path, true)
      requireText(target.kind)
      if (target.open) {
        if (!workspaceStore.isActive(documentKey(target.identity)) ||
          (workspaceStore.get(documentKey(target.identity))?.revision ?? 0) !== target.revision) {
          throw new Error('Document changed during the command. Retry.')
        }
        const handle = editorRef.current
        const next = handle
          ? handle.applyEdits(edits)
          : applyResolved(target.text, resolveEdits(target.text, edits))
        if (!handle) setText(next)
        return { path: target.path, created: target.created, text: next }
      }
      const next = applyResolved(target.text, resolveEdits(target.text, edits))
      await writeBack(target, next)
      return { path: target.path, created: target.created, text: next }
    }),
    writeText: async (next, path) => commandFor(path, async () => {
      requirePath(path, 'ideate_write')
      const target = await resolveTarget(path, true)
      requireText(target.kind)
      if (target.open && editorRef.current) editorRef.current.replaceText(next)
      else await writeBack(target, next)
      return { path: target.path, created: target.created }
    }),
    openFile: async (path) => {
      if (!hasWorkspace) throw new Error('No repository is connected — nothing to open.')
      if (!repoFilePaths.includes(path)) {
        throw new Error(`No such file in ${workspaceLabel}: ${path}. Call ideate_list_files to see what is there.`)
      }
      setLinkTrail([])
      if (!await openFile(path)) {
        throw new Error(`Could not open ${path}; the workspace changed or its content could not be loaded.`)
      }
    },
    createFile: (path, content) => commandFor(path, async () => {
      if (!hasWorkspace) throw new Error('No repository is connected — nothing to create a file in.')
      const invalid = validatePath(path)
      if (invalid) throw new Error(invalid)
      if (fileKind(path) === 'excalidraw') {
        throw new Error(
          `${path} is a canvas, and this tool does not create a canvas. Use ` +
            'ideate_create_canvas. It takes the same path, and it draws the canvas in the ' +
            'same call.',
        )
      }
      if (await pathExists(path)) {
        throw new Error(
          `${path} already exists. Use ideate_edit (or ideate_write) with that path to ` +
            'change it — neither needs the file open.',
        )
      }
      const body = content ?? templateFor(fileKind(path))
      if (!await flushOutgoingDraft()) throw new Error('Could not preserve the open document before creating a file.')
      const written = await createDraftResult(docIdForPath(path), body)
      if (!written.ok) throw new Error(`Could not create ${path}: browser storage is ${written.reason}.`)
      activateCreated(path, body)
    }),
    createCanvas: async (path, ops) => commandFor(path, async () => {
      const operationWorkspace = workspaceSelectionRef.current
      const identity = identityFor(path)
      const expectedRevision = workspaceStore.get(documentKey(identity))?.revision ?? 0
      if (!hasWorkspace) throw new Error('No repository is connected — nothing to create a canvas in.')
      const invalid = validatePath(path)
      if (invalid) throw new Error(invalid)
      if (fileKind(path) !== 'excalidraw') {
        throw new Error(
          `${path} is not a canvas. The extension decides the editor, and a canvas ends ` +
            'in .excalidraw. For a diagram or a document, use ideate_create_file.',
        )
      }
      if (await pathExists(path)) throw new Error(`${path} already exists. Use ideate_scene_edit to draw on it.`)
      const drawn = ops.length
        ? await applySceneOps(EMPTY_SCENE, ops)
        : { text: EMPTY_SCENE, elementCount: 0, warnings: [] }
      if (operationWorkspace !== workspaceSelectionRef.current ||
        (workspaceStore.get(documentKey(identity))?.revision ?? 0) !== expectedRevision) {
        throw new Error('Workspace or document changed while drawing the canvas. Retry.')
      }
      if (!await flushOutgoingDraft()) throw new Error('Could not preserve the open document before creating a canvas.')
      const written = await createDraftResult(docIdForPath(path), drawn.text)
      if (!written.ok) throw new Error(`Could not create ${path}: browser storage is ${written.reason}.`)
      activateCreated(path, drawn.text)
      return {
        path,
        created: true,
        applied: ops.length,
        revision: workspaceStore.get(documentKey(identity))?.revision ?? expectedRevision + 1,
        elementCount: drawn.elementCount,
        warnings: drawn.warnings,
      }
    }),
    check: async ({ text: override, path }) => {
      if (override !== undefined) {
        return {
          path: path ?? openPath,
          diagnostics: await collectDiagnostics(
            override,
            path === undefined ? kind : fileKind(path),
            appliedConfig,
          ),
        }
      }
      const target = await resolveTarget(path, false)
      return { path: target.path, diagnostics: await collectDiagnostics(target.text, target.kind, appliedConfig) }
    },
    sceneGet: async (full, path) => {
      const target = await resolveTarget(path, false)
      requireScene(target.kind)
      return { path: target.path, revision: target.revision, ...summarizeScene(target.text, full) }
    },
    sceneEdit: async (ops, path, expectedRevision) => commandFor(path, async () => {
      requirePath(path, 'ideate_scene_edit')
      const target = await resolveTarget(path, true)
      requireScene(target.kind)
      const actualRevision = target.created ? 'absent' : target.revision
      if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
        throw new Error(
          `Scene revision conflict for ${target.path ?? 'the untitled canvas'}: ` +
          `expected ${expectedRevision}, current ${actualRevision}. Read it again and retry.`,
        )
      }
      const result = await applySceneOps(target.text, ops)
      await writeBack(target, result.text)
      return {
        path: target.path,
        created: target.created,
        applied: ops.length,
        revision: workspaceStore.get(documentKey(target.identity))!.revision,
        elementCount: result.elementCount,
        warnings: result.warnings,
      }
    }),
    sceneRender: async (path, ids) => {
      const target = await resolveTarget(path, false)
      requireScene(target.kind)
      const image = await renderSceneThumbnail(target.text, canvasTheme, ids)
      const { elementCount, warnings } = summarizeScene(target.text)
      return {
        path: target.path,
        elementCount,
        rendered: image.rendered,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        scale: image.scale,
        dataBase64: image.base64,
        warnings,
      }
    },
    cursor: () => editorRef.current?.cursor() ?? null,
  }

  const mcpOrigin = normalizeMcpOrigin(configuredOrigin ?? defaultOrigin)
  const agentLink = useAgentLink({ enabled, mcpOrigin, state: bridgeState, caps })

  return {
    editorRef,
    markdownPreviewRef,
    revealInPreview,
    revealInEditor,
    mcpOrigin,
    agentLink,
    linkAttached: enabled && agentLink.status === 'attached',
    linkWaiting: enabled && agentLink.status === 'paired',
  }
}
