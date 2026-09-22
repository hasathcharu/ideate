'use client'

import { useMemo } from 'react'
import DiagramViewport from './DiagramViewport'

export default function SvgPreview({ source }: { source: string }) {
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, [source])
  return <DiagramViewport imageSrc={src} imageAlt="SVG preview" background="var(--background)" />
}
