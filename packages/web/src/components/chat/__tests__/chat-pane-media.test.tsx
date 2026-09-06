import { describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { apiMocks, pane, renderPane } from './chat-pane-fixture'
import { reconcileMessages, type MediaAttachment, type Message } from '@/lib/conversations'

describe('ChatPane media identity', () => {
  it.each(['s1', null])('associates same-named uploads before dispatch and new-session handoff (%s)', async (sessionId) => {
    const media: MediaAttachment[] = ['a', 'b'].map((id) => ({
      type: 'video', url: `blob:${id}`, name: 'capture.mp4',
      file: new File([id], 'capture.mp4', { type: 'video/mp4' }),
    }))
    apiMocks.uploadFile.mockReset().mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce({ id: 'b' })
    const onSessionCreated = vi.fn()
    let optimistic: Message | undefined
    pane.liveSessionState.beginSend.mockImplementation((message: Message) => { optimistic = { ...message } })
    pane.liveSessionState.updateSendMedia.mockImplementation((id: string, uploaded: MediaAttachment[]) => {
      expect(id).toBe(optimistic?.id)
      optimistic = { ...optimistic!, media: uploaded }
    })
    const persisted = (): Message => ({
      id: 'server', role: 'user', content: 'compare', timestamp: Date.now(),
      media: ['a', 'b'].map((id) => ({ type: 'video', name: 'capture.mp4', url: `/api/files/${id}` })),
    })
    const dispatch = async () => {
      const merged = reconcileMessages([optimistic!], [persisted()])
      expect(merged).toHaveLength(1)
      expect(merged[0].id).toBe(optimistic?.id)
      return { id: 'new-session' }
    }
    apiMocks.sendMessage.mockImplementation(dispatch)
    apiMocks.createSession.mockImplementation(dispatch)
    renderPane({ sessionId, onSessionCreated })

    await act(async () => { expect(await pane.composerOnSend?.('compare', media)).toBe(true) })

    expect(optimistic?.media?.map((item) => item.fileId)).toEqual(['a', 'b'])
    const call = sessionId ? apiMocks.sendMessage.mock.calls[0]?.[1] : apiMocks.createSession.mock.calls[0]?.[0]
    expect(call).toMatchObject({ attachments: ['a', 'b'] })
    if (!sessionId) {
      expect(onSessionCreated).toHaveBeenCalledWith('new-session', expect.objectContaining({ media: optimistic?.media }))
    }
  })

})
