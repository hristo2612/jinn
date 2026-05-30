import React, { useState, useEffect, useCallback } from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { FileAttachment } from './file-attachment'
import { VoiceMessage } from './voice-message'
import { AssistRequestCard } from './assist-request-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Thumbnail image with a shimmer skeleton while it loads/decodes, a cross-fade in
 * on `onLoad`, and a graceful broken-image fallback on error (never an infinite
 * skeleton). The skeleton overlays the reserved slot so there's no layout shift.
 */
function LoadingImage({
  src,
  alt,
  variant,
}: {
  src: string
  alt: string
  variant: 'single' | 'grid'
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const isGrid = variant === 'grid'

  if (status === 'error') {
    return (
      <div
        role="img"
        aria-label={`${alt} (failed to load)`}
        className={cn(
          'flex items-center justify-center rounded-[var(--radius-lg)] bg-[var(--fill-secondary)] text-[var(--text-tertiary)]',
          isGrid ? 'h-[130px] w-full' : 'h-[140px] w-full',
        )}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
      </div>
    )
  }

  return (
    <div
      className="relative"
      // Reserve the slot so the skeleton has size and the image swap causes no jump.
      style={!isGrid && status === 'loading' ? { minHeight: 140 } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('error')}
        className={cn(
          'block rounded-[var(--radius-lg)] transition-opacity duration-300',
          isGrid ? 'h-[130px] w-full object-cover' : 'w-full',
          status === 'loaded' ? 'opacity-100' : 'opacity-0',
        )}
      />
      {status === 'loading' && (
        <Skeleton
          data-testid="image-skeleton"
          className="absolute inset-0 h-full w-full rounded-[var(--radius-lg)]"
        />
      )}
    </div>
  )
}

/* Full-screen image viewer with close + download. Closes on backdrop click or Esc. */
function ImageLightbox({
  url,
  name,
  onClose,
}: {
  url: string
  name?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name || 'Image preview'}
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-[var(--space-6)]"
    >
      {/* Controls */}
      <div className="absolute top-[var(--space-4)] right-[var(--space-4)] flex gap-[var(--space-2)]">
        <a
          href={url}
          download={name || 'image'}
          aria-label="Download image"
          onClick={(e) => e.stopPropagation()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name || 'Image'}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-[var(--radius-md)] object-contain"
      />
    </div>
  )
}

/**
 * Render a message's media. Images go in a responsive grid (single image stays
 * large; multiples tile 2-up) and open a full-screen lightbox on click. Audio
 * uses the voice player; every other type is a downloadable file chip.
 * Handles single AND multiple attachments without clobbering.
 */
export function MessageMedia({ media, isUser }: { media: MediaAttachment[]; isUser: boolean }) {
  const [lightbox, setLightbox] = useState<{ url: string; name?: string } | null>(null)
  const close = useCallback(() => setLightbox(null), [])

  const images = media.filter((m) => m.type === 'image')
  const audio = media.filter((m) => m.type === 'audio')
  const files = media.filter((m) => m.type === 'file')
  const assists = media.filter((m) => m.type === 'assist-request')

  return (
    <>
      {images.length > 0 && (
        <div
          className={
            images.length > 1
              ? 'mt-[var(--space-2)] grid grid-cols-2 gap-[var(--space-2)] max-w-[280px]'
              : 'mt-[var(--space-2)] max-w-[280px]'
          }
        >
          {images.map((m, mi) => (
            <button
              key={`img-${mi}`}
              type="button"
              onClick={() => setLightbox({ url: m.url, name: m.name })}
              aria-label={`Open ${m.name || 'image'}`}
              className="block overflow-hidden rounded-[var(--radius-lg)] p-0 border-0 bg-transparent cursor-pointer"
            >
              <LoadingImage
                src={m.url}
                alt={m.name || 'Image'}
                variant={images.length > 1 ? 'grid' : 'single'}
              />
            </button>
          ))}
        </div>
      )}

      {audio.map((m, mi) => (
        <div key={`audio-${mi}`} className="mt-[var(--space-2)]">
          <VoiceMessage src={m.url} duration={m.duration || 0} waveform={m.waveform || []} isUser={isUser} />
        </div>
      ))}

      {files.length > 0 && (
        <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
          {files.map((m, mi) => (
            <FileAttachment
              key={`file-${mi}`}
              name={m.name || 'File'}
              size={m.size}
              mimeType={m.mimeType}
              url={m.url}
              isUser={isUser}
            />
          ))}
        </div>
      )}

      {assists.map((m, mi) => (
        <div key={`assist-${mi}`} className="mt-[var(--space-2)] max-w-[360px]">
          <AssistRequestCard reqId={m.reqId!} reason={m.reason ?? 'Help needed'} url={m.url || undefined} status={m.status} />
        </div>
      ))}

      {lightbox && <ImageLightbox url={lightbox.url} name={lightbox.name} onClose={close} />}
    </>
  )
}
