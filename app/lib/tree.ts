import type { TreeNode } from './types'

/**
 * Which editor a file opens in. - `mermaid` — pure diagram source, edited beside a rendered
 * diagram.
 */
export type FileKind = 'mermaid' | 'markdown' | 'excalidraw'

/** File extensions treated as pure Mermaid diagrams. `.md` is deliberately NOT
 *  here: it is a markdown document, which may *contain* mermaid fences. */
export const MERMAID_EXTENSIONS = ['.mmd', '.mermaid'] as const

/** File extensions treated as markdown documents. */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const

/** File extension treated as an Excalidraw scene. */
export const EXCALIDRAW_EXTENSION = '.excalidraw'

export const SVG_EXTENSION = '.svg'
export const RASTER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.gif'] as const
export const IMAGE_EXTENSIONS = [SVG_EXTENSION, ...RASTER_IMAGE_EXTENSIONS] as const

/** Every extension the file tree surfaces, across all kinds. */
export const DIAGRAM_EXTENSIONS = [
  ...MERMAID_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  EXCALIDRAW_EXTENSION,
  ...IMAGE_EXTENSIONS,
] as const

/** Human-readable list of the accepted extensions, for validation messages. */
export const DIAGRAM_EXTENSIONS_LABEL = DIAGRAM_EXTENSIONS.join(', ')

export function isDiagramFile(path: string): boolean {
  const lower = path.toLowerCase()
  return DIAGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function isSvgFile(path: string): boolean {
  return path.toLowerCase().endsWith(SVG_EXTENSION)
}

export function isRasterImageFile(path: string): boolean {
  const lower = path.toLowerCase()
  return RASTER_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function isExcalidrawFile(path: string): boolean {
  return path.toLowerCase().endsWith(EXCALIDRAW_EXTENSION)
}

export function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * The recognized extension `path` ends with, as it is actually spelled there (case preserved), or
 * `''` for a path with none.
 */
export function fileExtension(path: string): string {
  const lower = path.toLowerCase()
  const match = DIAGRAM_EXTENSIONS.find((ext) => lower.endsWith(ext))
  return match ? path.slice(path.length - match.length) : ''
}

/**
 * Which editor `path` opens in. Mermaid is the fallback: an unknown (or absent) extension lands in
 * the plain text editor, which degrades to "edit the raw text" rather than to a canvas that can't
 * parse the file.
 */
export function fileKind(path: string | null): FileKind {
  if (!path) return 'mermaid'
  if (isExcalidrawFile(path)) return 'excalidraw'
  if (isMarkdownFile(path)) return 'markdown'
  return 'mermaid'
}

/** Build a nested tree from a flat list of file paths (the shape returned by the Git trees API). */
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

/** Every directory path at or under a node. The counterpart of
 *  {@link collectFilePaths}, used to expand a whole tree at once. */
export function collectDirPaths(node: TreeNode): string[] {
  if (node.type === 'file') return []
  return [node.path, ...(node.children ?? []).flatMap(collectDirPaths)]
}

/** Whether `path` matches a sidebar search `query`. */
export function pathMatchesQuery(path: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const lower = path.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

function sortTree(node: TreeNode): void {
  if (!node.children) return
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const child of node.children) sortTree(child)
}
