import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Shared sizing for the header's filled action buttons — Commit and Export.
 *
 *  `size="sm"` alone does not make them match. The split Commit button needs
 *  `bg-clip-border` so the page colour cannot bleed through the seam between its
 *  halves, and that paints its fill out to the full 28px box, while a button
 *  keeping the base `bg-clip-padding` gutter only ever paints 26px of its own. The
 *  two sat side by side at visibly different sizes. One clip mode and one height
 *  settle it, splitting the difference between the sizes they used to render at.
 */
export const HEADER_ACTION_BUTTON = 'h-[27px] bg-clip-border'
