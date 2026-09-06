import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ChatInput } from '../chat-input'

vi.mock('@/hooks/use-employees', () => { const data = { employees: [] }; return { useOrg: () => ({ data }) } })
vi.mock('@/hooks/use-skills', () => { const data: never[] = []; const refetch = vi.fn(); return { useSkills: () => ({ data, refetch }) } })
vi.mock('@/hooks/use-stt', () => ({ useStt: () => ({ state: 'idle', languages: ['en'], selectedLanguage: 'en' }) }))
vi.mock('@/components/stt/whisper-download-modal', () => ({ WhisperDownloadModal: () => null }))
const props = { disabled: false, loading: false, onNewSession: vi.fn(), onStatusRequest: vi.fn() }
beforeEach(() => sessionStorage.clear())

it('restores only the selected conversation draft after unmount', () => {
  const onSend = vi.fn()
  const first = render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsent alpha' } })
  first.unmount()
  const second = render(<ChatInput {...props} sessionId="beta" onSend={onSend} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  second.unmount()
  render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Unsent alpha')
  expect(onSend).not.toHaveBeenCalled()
})

it('keeps the draft when sending is rejected, then clears it after acknowledgment', async () => {
  const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep until accepted' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep until accepted')
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
})

it('does not erase a newer draft when an earlier send completes', async () => {
  let accept!: (value: boolean) => void
  const onSend = vi.fn(() => new Promise<boolean>(r => { accept = r }))
  render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await act(async () => accept(true))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next draft')
  expect(onSend).toHaveBeenCalledTimes(1)
})

it('carries a new-chat draft into its assigned session and preserves later typing', async () => {
  let accept!: (value: boolean) => void
  const onSend = vi.fn((_text: string, _attachments?: { name?: string }[]) => new Promise<boolean>(r => { accept = r }))
  const view = render(<ChatInput {...props} sessionId={null} onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next draft' } })
  view.rerender(<ChatInput {...props} sessionId="created-session" onSend={onSend} />)
  await act(async () => accept(true))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next draft')
  view.unmount()
  render(<ChatInput {...props} sessionId="created-session" onSend={onSend} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next draft')
})

it('still accepts and clears a send when browser storage is unavailable', async () => {
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled') })
  try {
    render(<ChatInput {...props} sessionId="alpha" onSend={vi.fn().mockResolvedValue(true)} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Send without storage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
  } finally { read.mockRestore(); write.mockRestore() }
})

it('clears the currently remounted composer when its original send is acknowledged', async () => {
  let accept!: (value: boolean) => void
  const onSend = vi.fn(() => new Promise<boolean>(r => { accept = r }))
  const first = render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  first.unmount()
  render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  await act(async () => accept(true))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
})

it('preserves a changed remounted composer after an old acknowledgment', async () => {
  let accept!: (value: boolean) => void
  const onSend = vi.fn(() => new Promise<boolean>(r => { accept = r }))
  const first = render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  first.unmount()
  render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next draft' } })
  await act(async () => accept(true))
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next draft')
})

it('removes acknowledged attachments while keeping files added during the request', async () => {
  let accept!: (value: boolean) => void
  const onSend = vi.fn((_text: string, _attachments?: { name?: string }[]) => new Promise<boolean>(r => { accept = r }))
  const view = render(<ChatInput {...props} sessionId="alpha" onSend={onSend} />)
  const fileInput = view.container.querySelector('input[type="file"]')!
  fireEvent.change(fileInput, { target: { files: [new File(['first'], 'first.txt', {type:'text/plain'})] } })
  await waitFor(() => expect(screen.getAllByRole('button', {name:'Remove attachment'})).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', {name:'Send message'}))
  fireEvent.change(fileInput, { target: { files: [new File(['second'], 'second.txt', {type:'text/plain'})] } })
  await waitFor(() => expect(screen.getAllByRole('button', {name:'Remove attachment'})).toHaveLength(2))
  await act(async () => accept(true))
  expect.soft(screen.getAllByRole('button', {name:'Remove attachment'})).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', {name:'Send message'}))
  expect(onSend.mock.calls[1][1]?.map(a => a.name)).toEqual(['second.txt'])
})

it('clears an accepted draft when storage quota prevented saving its text', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    render(<ChatInput {...props} sessionId="quota" onSend={vi.fn().mockResolvedValue(true)} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accepted despite quota' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
  } finally { write.mockRestore() }
})
