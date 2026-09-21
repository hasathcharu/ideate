import { saveLocalFileAndClearDraft } from './storage'

/** Settle only paths whose bytes actually reached browser storage. */
export async function saveLocalBatch(
  paths: readonly string[], workingCopy: (path: string) => Promise<string | null>, draftId: (path: string) => string,
): Promise<{ saved: Array<{ path: string; content: string }>; failed: string[] }> {
  const saved: Array<{ path: string; content: string }> = []
  const failed: string[] = []
  for (const path of paths) {
    const content = await workingCopy(path)
    if (content === null || !(await saveLocalFileAndClearDraft(path, content, draftId(path))).ok) {
      failed.push(path)
      continue
    }
    saved.push({ path, content })
  }
  return { saved, failed }
}
