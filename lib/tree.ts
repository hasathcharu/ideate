import type { TreeNode } from './types'

/** File extensions treated as Mermaid diagrams. */
export const DIAGRAM_EXTENSIONS = ['.md', '.mmd', '.mermaid'] as const

export function isDiagramFile(path: string): boolean {
  const lower = path.toLowerCase()
  return DIAGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext))
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

function sortTree(node: TreeNode): void {
  if (!node.children) return
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const child of node.children) sortTree(child)
}
