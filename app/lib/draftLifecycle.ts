/** A never-saved named file needs a draft even when its content is empty. */
export function needsDraft(differsFromBaseline: boolean, pending: boolean): boolean {
  return pending || differsFromBaseline
}

/** An acknowledged scratch save spends only the revision it submitted. */
export function canConsumeScratchDraft(
  fromScratch: boolean, submitted: string, parked: string | null,
  submittedRevision: number, currentRevision: number,
): boolean {
  return fromScratch && submittedRevision === currentRevision && parked === submitted
}
