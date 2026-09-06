import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { reconcileMessages, type Message, type MediaAttachment } from '@/lib/conversations'
import { MessageMedia } from '../message-media'

function attachment(id: string, url: string, type: MediaAttachment['type']): Message {
  return {
    id, role: 'assistant', content: '', timestamp: 1000,
    media: [{ type, url, name: type === 'image' ? 'capture.png' : 'capture.mp4', mimeType: type === 'image' ? 'image/png' : 'video/mp4' }],
  }
}

describe.each(['video', 'file', 'image'] as const)('same-named %s sources', (type) => {
  it('keeps both file references through a history refresh and renders each source', () => {
    const first = attachment('history-a', '/api/files/a', type)
    const second = attachment('live-b', '/api/files/b', type)
    const merged = reconcileMessages([second], [first], 2000)
    render(<MessageMedia media={merged.flatMap((m) => m.media ?? [])} isUser={false} />)

    if (type === 'image') {
      const openers = screen.getAllByLabelText('Open capture.png')
      expect(openers).toHaveLength(2)
      for (const [index, url] of ['/api/files/a', '/api/files/b'].entries()) {
        fireEvent.click(openers[index])
        expect(screen.getByLabelText('Download image').getAttribute('href')).toBe(url)
        fireEvent.click(screen.getByLabelText('Close'))
      }
    } else {
      const playButtons = screen.getAllByLabelText('Play capture.mp4')
      expect(playButtons).toHaveLength(2)
      playButtons.forEach((button) => fireEvent.click(button))
      const players = screen.getAllByTestId('video-player-element')
      expect(players.map((player) => player.getAttribute('src'))).toEqual(['/api/files/a?quality=low', '/api/files/b?quality=low'])
    }
    expect(merged.map((m) => m.id)).toEqual(['history-a', 'live-b'])
  })

  it('still groups a live attachment with its identical persisted reference', () => {
    const live = attachment('local-a', '/api/files/a', type)
    const persisted = attachment('history-a', '/api/files/a', type)
    const merged = reconcileMessages([live], [persisted], 2000)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: live.id, media: persisted.media })
  })
})
