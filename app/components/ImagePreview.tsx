'use client'

import { useEffect, useMemo, useState } from 'react'
import DiagramViewport from './DiagramViewport'

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
}

export default function ImagePreview({ path, base64, blob }: { path: string; base64?: string; blob?: Blob }) {
  const dataSrc = useMemo(() => {
    if (!base64) return null
    const extension = path.split('.').pop()?.toLowerCase() ?? 'png'
    return `data:${MIME[extension] ?? 'application/octet-stream'};base64,${base64}`
  }, [path, base64])
  const [blobSrc, setBlobSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setBlobSrc(null)
      return
    }
    const url = URL.createObjectURL(blob)
    setBlobSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [blob])
  const src = blobSrc ?? dataSrc

  return src
    ? <DiagramViewport imageSrc={src} imageAlt={path.split('/').pop() ?? path} background="var(--background)" />
    : null
}
