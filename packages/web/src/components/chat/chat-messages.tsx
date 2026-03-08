"use client"
import React, { useEffect, useRef, useState } from 'react'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { parseMedia } from '@/lib/conversations'
import { FileAttachment } from './file-attachment'
import { VoiceMessage } from './voice-message'

/* ── Tool grouping ──────────────────────────────────────── */

type MessageItem =
  | { kind: 'message'; msg: Message; index: number }
  | { kind: 'tool-group'; msgs: Message[]; startIndex: number }

function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === 'assistant' && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (i < messages.length && messages[i].role === 'assistant' && messages[i].toolCall) {
        toolMsgs.push(messages[i])
        i++
      }
      items.push({ kind: 'tool-group', msgs: toolMsgs, startIndex: start })
    } else {
      items.push({ kind: 'message', msg: messages[i], index: i })
      i++
    }
  }
  return items
}

function ToolGroup({ msgs, isActive }: { msgs: Message[]; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const allDone = msgs.every((m) => m.content.startsWith('Used '))
  const label = isActive && !allDone
    ? `${msgs.length} tool${msgs.length !== 1 ? 's' : ''} running…`
    : `${msgs.length} tool${msgs.length !== 1 ? 's' : ''} used`

  return (
    <div style={{
      padding: '0 var(--space-4)',
      marginBottom: 'var(--space-1)',
    }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '5px var(--space-3)',
          borderRadius: 'var(--radius-full, 999px)',
          background: 'var(--fill-secondary)',
          border: '1px solid var(--separator)',
          fontSize: 'var(--text-caption1)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'background 150ms ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--fill-secondary)')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        {label}
        {isActive && !allDone && (
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--system-blue)',
            animation: 'jimmy-pulse 1.4s infinite',
          }} />
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            opacity: 0.5,
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-1)',
          marginTop: 'var(--space-1)',
          paddingLeft: 'var(--space-1)',
        }}>
          {msgs.map((m) => (
            <span
              key={m.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 'var(--radius-full, 999px)',
                background: 'var(--fill-tertiary)',
                border: '1px solid var(--separator)',
                fontSize: 'var(--text-caption2)',
                color: 'var(--text-tertiary)',
              }}
            >
              {m.toolCall}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Markdown rendering ─────────────────────────────────── */

function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  // URLs, bold, inline code, italic — in priority order
  const regex = /(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])|(\*\*(.+?)\*\*)|(`([^`]+)`)|\*([^*]+)\*/g
  let last = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      parts.push(
        <a
          key={match.index}
          href={match[1]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--system-blue)', textDecoration: 'underline', textUnderlineOffset: 2 }}
        >
          {match[1]}
        </a>
      )
    } else if (match[2]) {
      parts.push(<strong key={match.index} style={{ fontWeight: 'var(--weight-bold)' }}>{match[3]}</strong>)
    } else if (match[4]) {
      parts.push(
        <code key={match.index} style={{
          background: 'var(--fill-secondary)',
          border: '1px solid var(--separator)',
          borderRadius: 5,
          padding: '1px 5px',
          fontSize: '0.88em',
          fontFamily: '"SF Mono", Menlo, monospace',
          color: 'var(--accent)',
        }}>{match[5]}</code>
      )
    } else if (match[6]) {
      parts.push(<em key={match.index} style={{ fontStyle: 'italic', opacity: 0.85 }}>{match[6]}</em>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <>{parts}</>
}

function CodeBlock({ code, keyProp }: { code: string; keyProp: number }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div key={keyProp} style={{ position: 'relative', margin: '8px 0' }}>
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          padding: '2px 8px',
          fontSize: 11,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--fill-secondary)',
          color: 'var(--text-secondary)',
          border: '1px solid var(--separator)',
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre className="code-block" style={{
        background: 'var(--fill-tertiary)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        overflowX: 'auto',
        fontSize: 13,
        lineHeight: 1.5,
        fontFamily: '"SF Mono", Menlo, monospace',
        color: 'var(--text-primary)',
      }}><code>{code}</code></pre>
    </div>
  )
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

function TableBlock({ headerLine, rows, keyProp }: { headerLine: string; rows: string[]; keyProp: number }) {
  const headers = parseTableRow(headerLine)
  const bodyRows = rows.map(parseTableRow)

  return (
    <div key={keyProp} style={{
      margin: '10px 0',
      borderRadius: 10,
      border: '1px solid var(--separator)',
      overflow: 'hidden',
    }}>
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{
          borderCollapse: 'collapse',
          fontSize: 'var(--text-footnote)',
          lineHeight: 1.6,
          width: '100%',
          minWidth: 'max-content',
        }}>
          <thead>
            <tr style={{ background: 'var(--fill-tertiary)' }}>
              {headers.map((h, hi) => (
                <th key={hi} style={{
                  textAlign: 'left',
                  padding: '10px 16px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  borderBottom: '1px solid var(--separator)',
                  maxWidth: 280,
                  wordBreak: 'break-word',
                }}>{inlineFormat(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 1 ? 'var(--fill-quaternary, transparent)' : 'transparent' }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{
                    padding: '10px 16px',
                    borderBottom: ri < bodyRows.length - 1 ? '1px solid var(--separator)' : 'none',
                    color: 'var(--text-primary)',
                    maxWidth: 280,
                    wordBreak: 'break-word',
                  }}>{inlineFormat(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatMessage(content: string): React.ReactNode {
  if (!content) return null
  const lines = content.split('\n')
  const result: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLines = []
      } else {
        inCodeBlock = false
        result.push(<CodeBlock key={i} keyProp={i} code={codeLines.join('\n')} />)
        codeLines = []
      }
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }

    // Table detection: header row | separator row | body rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerLine = line
      i++ // skip separator
      const tableRows: string[] = []
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 1].trim().endsWith('|') && !isTableSeparator(lines[i + 1])) {
        i++
        tableRows.push(lines[i])
      }
      result.push(<TableBlock key={`table-${i}`} keyProp={i} headerLine={headerLine} rows={tableRows} />)
      continue
    }

    if (line.trim() === '') { result.push(<div key={`space-${i}`} style={{ height: 6 }} />); continue }
    if (line.match(/^[-*] /)) {
      result.push(
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 2 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }}>&bull;</span>
          <span>{inlineFormat(line.slice(2))}</span>
        </div>
      )
      continue
    }
    if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1]
      result.push(
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 2 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0, fontWeight: 'var(--weight-semibold)', minWidth: 16 }}>{num}.</span>
          <span>{inlineFormat(line.replace(/^\d+\. /, ''))}</span>
        </div>
      )
      continue
    }
    if (line.startsWith('### ')) {
      result.push(
        <div key={i} style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-footnote)', marginTop: 'var(--space-2)', marginBottom: 2 }}>
          {inlineFormat(line.slice(4))}
        </div>
      )
      continue
    }
    if (line.startsWith('## ')) {
      result.push(
        <div key={i} style={{ fontWeight: 'var(--weight-bold)', fontSize: 'var(--text-subheadline)', marginTop: 'var(--space-3)', marginBottom: 3 }}>
          {inlineFormat(line.slice(3))}
        </div>
      )
      continue
    }
    if (line.startsWith('# ')) {
      result.push(
        <div key={i} style={{ fontWeight: 'var(--weight-bold)', fontSize: 'var(--text-body)', marginTop: 'var(--space-3)', marginBottom: 'var(--space-1)' }}>
          {inlineFormat(line.slice(2))}
        </div>
      )
      continue
    }
    result.push(<div key={i} style={{ marginBottom: 1 }}>{inlineFormat(line)}</div>)
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push(<CodeBlock key="trailing-code" keyProp={999} code={codeLines.join('\n')} />)
  }

  return <>{result}</>
}

/* ── Partial markdown fixer for streaming ───────────────── */

/**
 * Close unclosed markdown tokens so partial content renders cleanly.
 * Handles: code blocks (```), inline code (`), bold (**), italic (*).
 */
function closePartialMarkdown(text: string): string {
  let result = text

  // Count triple backticks — if odd, close the code block
  const tripleBackticks = (result.match(/```/g) || []).length
  if (tripleBackticks % 2 !== 0) {
    result += '\n```'
  }

  // Only fix inline markers outside of code blocks
  if (tripleBackticks % 2 === 0) {
    // Count inline backticks outside code blocks (simplified: count ` not part of ```)
    const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, '')
    const inlineBackticks = (withoutCodeBlocks.match(/`/g) || []).length
    if (inlineBackticks % 2 !== 0) {
      result += '`'
    }

    // Count ** pairs
    const boldMarkers = (withoutCodeBlocks.match(/\*\*/g) || []).length
    if (boldMarkers % 2 !== 0) {
      result += '**'
    }
  }

  return result
}

/* ── Timestamp formatting ──────────────────────────────── */

function formatTimestamp(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const isToday = now.toDateString() === date.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

function shouldShowTimestamp(messages: Message[], index: number): boolean {
  if (index === 0) return true
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}

/* ── Render media helpers ─────────────────────────────── */

function renderMedia(media: MediaAttachment[], isUser: boolean) {
  const images = media.filter(m => m.type === 'image')
  const audio = media.filter(m => m.type === 'audio')
  const files = media.filter(m => m.type === 'file')

  return (
    <>
      {images.map((m, mi) => (
        <div key={`img-${mi}`} style={{
          marginTop: 'var(--space-2)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          maxWidth: 280,
        }}>
          <img
            src={m.url}
            alt={m.name || 'Image'}
            style={{ width: '100%', display: 'block', borderRadius: 'var(--radius-lg)', cursor: 'pointer' }}
            onClick={() => window.open(m.url, '_blank')}
          />
        </div>
      ))}
      {audio.map((m, mi) => (
        <div key={`audio-${mi}`} style={{ marginTop: 'var(--space-2)' }}>
          <VoiceMessage
            src={m.url}
            duration={m.duration || 0}
            waveform={m.waveform || []}
            isUser={isUser}
          />
        </div>
      ))}
      {files.map((m, mi) => (
        <div key={`file-${mi}`} style={{ marginTop: 'var(--space-2)' }}>
          <FileAttachment
            name={m.name || 'File'}
            size={m.size}
            mimeType={m.mimeType}
            url={m.url}
            isUser={isUser}
          />
        </div>
      ))}
    </>
  )
}

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  streamingText?: string
}

export function ChatMessages({ messages, loading, streamingText }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevMsgCount = useRef(0)

  useEffect(() => {
    // Instant scroll on initial load / session switch, smooth for new messages
    const isInitialLoad = prevMsgCount.current === 0 && messages.length > 0
    const behavior = isInitialLoad ? 'instant' as const : 'smooth' as const
    bottomRef.current?.scrollIntoView({ behavior })
    prevMsgCount.current = messages.length
  }, [messages, loading])

  if (messages.length === 0 && !loading) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 'var(--text-title3)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-tertiary)',
          }}>
            Start a conversation
          </div>
          <div style={{
            fontSize: 'var(--text-footnote)',
            color: 'var(--text-quaternary)',
            marginTop: 'var(--space-2)',
          }}>
            Send a message or use /new to begin
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-messages-scroll" style={{
      flex: 1,
      overflowY: 'auto',
      padding: 'var(--space-3) 0 var(--space-6) 0',
      background: 'var(--bg)',
    }}>
      {groupMessages(messages).map((item) => {
        if (item.kind === 'tool-group') {
          const firstMsg = item.msgs[0]
          const showTimestamp = shouldShowTimestamp(messages, item.startIndex)
          const prevMsg = item.startIndex > 0 ? messages[item.startIndex - 1] : null
          const isActive = loading && item.startIndex + item.msgs.length === messages.length
          return (
            <div key={`tg-${item.startIndex}`}>
              {showTimestamp && (
                <div style={{
                  textAlign: 'center',
                  padding: 'var(--space-3) 0',
                  fontSize: 'var(--text-caption2)',
                  color: 'var(--text-tertiary)',
                }}>
                  {formatTimestamp(firstMsg.timestamp)}
                </div>
              )}
              {!showTimestamp && prevMsg && (
                <div style={{ height: prevMsg.role !== 'assistant' ? 'var(--space-4)' : 'var(--space-1)' }} />
              )}
              <ToolGroup msgs={item.msgs} isActive={isActive} />
            </div>
          )
        }

        const { msg, index: i } = item
        const isUser = msg.role === 'user'
        const showTimestamp = shouldShowTimestamp(messages, i)
        const media = msg.media || parseMedia(msg.content)

        // Strip media URLs from text for display
        let textContent = msg.content
        if (media.length > 0 && !msg.media) {
          media.forEach(m => {
            textContent = textContent.replace(m.url, '')
            textContent = textContent.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
          })
          textContent = textContent.trim()
        }
        // Hide auto-generated content labels for media-only messages
        if (msg.media && msg.media.length > 0) {
          const isAutoLabel = textContent.startsWith('[') && textContent.endsWith(']')
          if (isAutoLabel) textContent = ''
        }

        return (
          <div key={msg.id || i}>
            {/* Timestamp divider */}
            {showTimestamp && (
              <div style={{
                textAlign: 'center',
                padding: 'var(--space-3) 0',
                fontSize: 'var(--text-caption2)',
                color: 'var(--text-tertiary)',
              }}>
                {formatTimestamp(msg.timestamp)}
              </div>
            )}

            {/* Spacing between role switches */}
            {!showTimestamp && i > 0 && (
              <div style={{ height: messages[i - 1].role !== msg.role ? 'var(--space-4)' : 'var(--space-1)' }} />
            )}

            {/* User message */}
            {isUser && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                padding: '0 var(--space-4)',
                marginBottom: 'var(--space-1)',
              }}>
                {textContent && (
                  <div className="user-msg-bubble" style={{
                    padding: 'var(--space-3) var(--space-4)',
                    borderRadius: 'var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg)',
                    background: 'var(--accent)',
                    color: 'var(--accent-contrast)',
                    fontSize: 'var(--text-subheadline)',
                    lineHeight: 'var(--leading-relaxed)',
                    fontWeight: 'var(--weight-medium)',
                    boxShadow: 'var(--shadow-subtle)',
                  }}>
                    {formatMessage(textContent)}
                  </div>
                )}
                {media.length > 0 && (
                  <div className="user-msg-bubble">
                    {renderMedia(media, true)}
                  </div>
                )}
              </div>
            )}

            {/* Assistant message */}
            {!isUser && (
              <div className="assistant-msg-row" style={{
                display: 'flex',
                justifyContent: 'flex-start',
                padding: '0 var(--space-4)',
                marginBottom: 'var(--space-1)',
              }}>
                <div className="assistant-msg-bubble" style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* Text bubble */}
                  {textContent && (
                    <div style={{
                      padding: 'var(--space-3) var(--space-4)',
                      borderRadius: 'var(--radius-sm) var(--radius-lg) var(--radius-lg) var(--radius-lg)',
                      background: 'var(--material-thin)',
                      border: '1px solid var(--separator)',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--text-subheadline)',
                      lineHeight: 'var(--leading-relaxed)',
                    }}>
                      {formatMessage(textContent)}
                    </div>
                  )}

                  {/* Media attachments */}
                  {media.length > 0 && renderMedia(media, false)}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Streaming message — shows text as it arrives */}
      {streamingText && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-start',
          padding: '0 var(--space-4)',
          marginBottom: 'var(--space-1)',
        }} className="assistant-msg-row">
          <div className="assistant-msg-bubble" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-sm) var(--radius-lg) var(--radius-lg) var(--radius-lg)',
              background: 'var(--material-thin)',
              border: '1px solid var(--separator)',
              color: 'var(--text-primary)',
              fontSize: 'var(--text-subheadline)',
              lineHeight: 'var(--leading-relaxed)',
            }}>
              {formatMessage(closePartialMarkdown(streamingText))}
            </div>
          </div>
        </div>
      )}

      {/* Loading indicator while waiting for engine response */}
      {loading && !streamingText && messages.length > 0 && (messages[messages.length - 1]?.role === 'user' || messages[messages.length - 1]?.toolCall) && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-start',
          padding: '0 var(--space-4)',
          marginTop: 'var(--space-2)',
        }}>
          <div style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-sm) var(--radius-lg) var(--radius-lg) var(--radius-lg)',
            background: 'var(--material-thin)',
            border: '1px solid var(--separator)',
          }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', height: 16 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--text-quaternary)',
                animation: 'jimmy-pulse 1.4s infinite',
                animationDelay: '0ms',
              }} />
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--text-quaternary)',
                animation: 'jimmy-pulse 1.4s infinite',
                animationDelay: '200ms',
              }} />
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--text-quaternary)',
                animation: 'jimmy-pulse 1.4s infinite',
                animationDelay: '400ms',
              }} />
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />

      {/* Keyframe animations + responsive bubble widths */}
      <style>{`
        @keyframes jimmy-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .assistant-msg-bubble { max-width: 100%; }
        .user-msg-bubble { max-width: 90%; }
        .assistant-msg-row { padding: 0 var(--space-2) !important; }
        @media (min-width: 1024px) {
          .assistant-msg-bubble { max-width: 75%; }
          .user-msg-bubble { max-width: 75%; }
          .assistant-msg-row { padding: 0 var(--space-4) !important; }
        }
        /* User message contrast fixes — ensure all child elements are visible on accent background */
        .user-msg-bubble code {
          background: rgba(255,255,255,0.2) !important;
          border-color: rgba(255,255,255,0.3) !important;
          color: inherit !important;
        }
        .user-msg-bubble .code-block,
        .user-msg-bubble pre {
          background: rgba(0,0,0,0.2) !important;
          border-color: rgba(255,255,255,0.15) !important;
          color: rgba(255,255,255,0.95) !important;
        }
        .user-msg-bubble a {
          color: inherit !important;
          text-decoration-color: rgba(255,255,255,0.6) !important;
        }
        .user-msg-bubble strong { color: inherit !important; }
        .user-msg-bubble em { color: inherit !important; opacity: 0.9; }
        .user-msg-bubble span { color: inherit !important; }
        .user-msg-bubble div { color: inherit !important; }
        .user-msg-bubble th, .user-msg-bubble td { color: inherit !important; }
        .user-msg-bubble table { border-color: rgba(255,255,255,0.2) !important; }
        .user-msg-bubble th { border-color: rgba(255,255,255,0.2) !important; }
        .user-msg-bubble td { border-color: rgba(255,255,255,0.15) !important; }
        .user-msg-bubble tr { background: transparent !important; }
        .user-msg-bubble thead tr { background: rgba(255,255,255,0.1) !important; }
        /* Selection visibility for user messages */
        .user-msg-bubble ::selection {
          background: rgba(255,255,255,0.35);
          color: inherit;
        }
        .user-msg-bubble ::-moz-selection {
          background: rgba(255,255,255,0.35);
          color: inherit;
        }
      `}</style>
    </div>
  )
}
