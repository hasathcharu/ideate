import type { BundledLanguage, Highlighter } from 'shiki'
import type { ThemeMode } from './mermaidConfig'

/**
 * Syntax highlighting for the code fences inside a markdown document, so a
 * rendered document reads like it does on GitHub.
 *
 * Shiki is loaded **lazily and only on demand** — the first fence that carries a
 * language triggers `await import('shiki')`, and each grammar arrives in its own
 * chunk after that. A document of pure prose (and every mermaid-only user) never
 * pays for any of it. Same reasoning as the Excalidraw split: this is a large
 * library serving one optional surface.
 *
 * Two further choices keep the cost down:
 *
 * - The **JavaScript regex engine**, not the default Oniguruma one, which would
 *   drag a ~500KB WASM binary along. `forgiving: true` makes a grammar that the
 *   JS engine can't fully express degrade to partial highlighting instead of
 *   throwing.
 * - **Both GitHub themes are loaded up front** (they are small JSON documents)
 *   and picked per render from the active palette's light/dark mode, because a
 *   dark-theme document with light-theme token colors is unreadable.
 */

/** Themes to load. Two, so a render can follow the active palette's mode without
 *  reloading the highlighter. */
const THEMES = ['github-light', 'github-dark'] as const

function themeFor(mode: ThemeMode): (typeof THEMES)[number] {
  return mode === 'dark' ? 'github-dark' : 'github-light'
}

/** The one highlighter instance, created on first use. Held as the *promise* so
 *  concurrent first calls share a single load rather than racing two of them. */
let highlighterPromise: Promise<Highlighter> | null = null

/** Bundled-language ids (including aliases like `js`/`yml`), resolved once. */
let knownLanguages: Set<string> | null = null

/** Grammars already loaded into the highlighter. */
const loadedLanguages = new Set<string>()

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighter, bundledLanguages }, { createJavaScriptRegexEngine }] =
        await Promise.all([import('shiki'), import('shiki/engine/javascript')])
      knownLanguages = new Set(Object.keys(bundledLanguages))
      return createHighlighter({
        themes: [...THEMES],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
    })()
  }
  return highlighterPromise
}

/**
 * Highlight one code fence, or return `null` when it can't be highlighted — an
 * unknown language, or shiki failing to load — so the caller falls back to the
 * plain escaped code block rather than losing the content.
 *
 * The returned markup is a full `<pre class="shiki">…</pre>`. Shiki's own inline
 * background and text color are stripped, so the block keeps the `.md-prose pre`
 * surface that follows the active theme; only the per-token colors survive.
 */
export async function highlightCode(
  code: string,
  language: string,
  mode: ThemeMode,
): Promise<string | null> {
  const lang = language.trim().toLowerCase()
  if (!lang) return null
  // markdown-it hands over the fence content with its closing newline, and shiki
  // faithfully renders that as one more `<span class="line">` — a blank row at the
  // bottom of every highlighted block.
  const source = code.replace(/\n$/, '')
  try {
    const highlighter = await getHighlighter()
    if (!knownLanguages?.has(lang)) return null
    if (!loadedLanguages.has(lang)) {
      await highlighter.loadLanguage(lang as BundledLanguage)
      loadedLanguages.add(lang)
    }
    return highlighter.codeToHtml(source, {
      lang: lang as BundledLanguage,
      theme: themeFor(mode),
      transformers: [
        {
          pre(node) {
            // Drop `background-color`/`color`: the block's surface is the app's,
            // and an inherited foreground keeps unstyled text legible on it.
            delete node.properties.style
            delete node.properties.tabindex
          },
        },
      ],
    })
  } catch {
    return null
  }
}
