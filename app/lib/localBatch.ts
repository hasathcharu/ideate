import { writeLocalFileResult } from './storage'

/** Settle only paths whose bytes actually reached browser storage. */
export function saveLocalBatch(
  paths: readonly string[], workingCopy: (path: string) => string | null,
): { saved: Array<{ path: string; content: string }>; failed: string[] } {
  const saved: Array<{ path: string; content: string }> = []
  const failed: string[] = []
  for (const path of paths) {
    const content = workingCopy(path)
    if (content === null || !writeLocalFileResult(path, content).ok) {
      failed.push(path)
      continue
    }
    saved.push({ path, content })
  }
  return { saved, failed }
}
