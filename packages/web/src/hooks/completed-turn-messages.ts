import type { Message } from '@/lib/conversations'

export function reconcileCompletedTurnMessages(args: {
  messages: Message[]
  turnStart: number
  finalMessage: Message
  exactResult?: string
}): Message[] {
  const turnStart = args.turnStart >= 0
    ? Math.min(args.turnStart, args.messages.length)
    : args.messages.length
  const exactResult = args.exactResult?.trim() ?? ''
  const preserved = args.messages.slice(turnStart)
    .filter((message) =>
      message.role === 'user'
      || Boolean(message.media?.length)
      || Boolean(message.toolCall)
      || message.role === 'notification'
      || hasDurableBlocks(message)
      || hasInterimProse(message, exactResult))
    .map((message) => {
      if (message.toolCall && !message.content.startsWith('Used ')) return { ...message, content: `Used ${message.toolCall}` }
      if (message.role === 'assistant' && !message.toolCall && !message.blocks?.length && !message.media?.length) {
        return { ...message, partial: undefined, meta: { assistantPhase: 'commentary', ...message.meta } }
      }
      return message
    })

  return [
    ...args.messages.slice(0, turnStart),
    ...preserved,
    { ...args.finalMessage, meta: { ...args.finalMessage.meta, assistantPhase: 'final' } },
  ]
}

function hasDurableBlocks(message: Message): boolean {
  return Boolean(message.blocks?.some((block) => block.type === 'delegation' || block.type === 'dispatch' || block.payload.kind === 'native-agents'))
}

function hasInterimProse(message: Message, exactResult: string): boolean {
  return message.role === 'assistant' && !message.blocks?.length
    && Boolean(message.content.trim()) && (!exactResult || message.content.trim() !== exactResult)
}
