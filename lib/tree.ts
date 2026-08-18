import type { TreeNode } from './types'

/** Which editor a file opens in. Mermaid files are text edited beside a rendered
 *  preview; Excalidraw files are JSON scenes edited on a full-bleed canvas. Both
 *  are plain text on disk, so every GitHub read/write path treats them alike —
 *  only the editing surface differs. */
export type FileKind = 'mermaid' | 'excalidraw'

/** File extensions treated as Mermaid diagrams. */
export const MERMAID_EXTENSIONS = ['.md', '.mmd', '.mermaid'] as const

/** File extension treated as an Excalidraw scene. */
export const EXCALIDRAW_EXTENSION = '.excalidraw'

/** Every extension the file tree surfaces, both kinds. */
export const DIAGRAM_EXTENSIONS = [...MERMAID_EXTENSIONS, EXCALIDRAW_EXTENSION] as const

/** Human-readable list of the accepted extensions, for validation messages. */
export const DIAGRAM_EXTENSIONS_LABEL = DIAGRAM_EXTENSIONS.join(', ')

export function isDiagramFile(path: string): boolean {
  const lower = path.toLowerCase()
  return DIAGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function isExcalidrawFile(path: string): boolean {
  return path.toLowerCase().endsWith(EXCALIDRAW_EXTENSION)
}

/**
 * Which editor `path` opens in. Mermaid is the fallback: an unknown (or absent)
 * extension lands in the text editor, which degrades to "edit the raw text"
 * rather than to a canvas that can't parse the file.
 */
export function fileKind(path: string | null): FileKind {
  return path && isExcalidrawFile(path) ? 'excalidraw' : 'mermaid'
}

/**
 * Build a nested tree from a flat list of file paths (the shape returned by the
 * Git trees API). Only directories that contain diagram files are included.
 * Directories sort before files; both alphabetically (case-insensitive).
 */
export function buildTree(filePaths: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] }

  for (const filePath of filePaths) {
    const parts = filePath.split('/').filter(Boolean)
    let cursor = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLeaf = i === parts.length - 1
      const currentPath = parts.slice(0, i + 1).join('/')
      cursor.children ??= []
      let next = cursor.children.find((c) => c.name === part)
      if (!next) {
        next = {
          name: part,
          path: currentPath,
          type: isLeaf ? 'file' : 'dir',
          ...(isLeaf ? {} : { children: [] }),
        }
        cursor.children.push(next)
      }
      cursor = next
    }
  }

  sortTree(root)
  return root.children ?? []
}

/**
 * Every diagram-file path at or under a node — the node itself when it's a file,
 * or all leaf files beneath it when it's a directory. Used to delete a folder.
 */
export function collectFilePaths(node: TreeNode): string[] {
  if (node.type === 'file') return [node.path]
  return (node.children ?? []).flatMap(collectFilePaths)
}

function sortTree(node: TreeNode): void {
  if (!node.children) return
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const child of node.children) sortTree(child)
}
