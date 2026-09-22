import { describe, expect, it } from 'vitest'
import { isDiagramFile, isRasterImageFile, isSvgFile } from './tree'

describe('repository image extensions', () => {
  it.each(['art.png', 'art.jpg', 'art.gif'])('surfaces and recognizes %s', (path) => {
    expect(isDiagramFile(path)).toBe(true)
    expect(isRasterImageFile(path)).toBe(true)
  })

  it('surfaces SVG as a text-backed image', () => {
    expect(isDiagramFile('images/architecture.svg')).toBe(true)
    expect(isSvgFile('images/architecture.svg')).toBe(true)
  })

  it.each(['art.jpeg', 'art.webp', 'art.bmp'])('does not surface unsupported %s images', (path) => {
    expect(isDiagramFile(path)).toBe(false)
    expect(isRasterImageFile(path)).toBe(false)
  })
})
