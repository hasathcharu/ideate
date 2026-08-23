/** `markdown-it-emoji` v3 ships no type declarations. Only the three plugin
 *  entry points are declared — the presets differ solely in how many shortcodes
 *  they carry, so they share one signature. */
declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it'

  type EmojiPlugin = (md: MarkdownIt, options?: Record<string, unknown>) => void

  /** Every shortcode GitHub knows, plus the `:)`-style shortcuts. */
  export const full: EmojiPlugin
  /** A smaller, commonly-used subset. */
  export const light: EmojiPlugin
  /** No shortcodes bundled — supply your own `defs`. */
  export const bare: EmojiPlugin
}
