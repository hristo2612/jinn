import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { StatusDot } from '@/components/chat/session-signals'
import { cn } from '@/lib/utils'

export interface MobileWorkingSetNavItem {
  id: string
  title: string
  employee?: string
  preview: string
  revision: number
  moved: boolean
}

function WorkingSetChip({
  item,
  active,
  onSelect,
}: {
  item: MobileWorkingSetNavItem
  active: boolean
  onSelect: (sessionId: string) => void
}) {
  const label = item.preview ? `${item.title} — ${item.preview}` : item.title
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      data-mobile-working-set-chip={item.id}
      data-mobile-working-set-active={active ? 'true' : 'false'}
      onClick={() => onSelect(item.id)}
      className={cn(
        'relative inline-flex h-[40px] min-w-[40px] items-center justify-center rounded-full text-left transition-[width,background-color] duration-[var(--duration-base)] [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none',
        active ? 'max-w-[132px] gap-1.5 bg-[var(--fill-secondary)] px-2' : 'w-[40px] shrink-0 bg-[var(--fill-tertiary)] px-1',
      )}
    >
      <EmployeeAvatar name={item.employee || 'jimbo'} size={24} fontSize={14} />
      {active ? (
        <span className="min-w-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {item.title}
        </span>
      ) : null}
      <span key={item.revision} data-mobile-working-set-preview className="sr-only motion-safe:animate-[jinn-mobile-preview-in_var(--duration-base)_var(--ease-smooth)]">
        {item.preview}
      </span>
      {item.moved ? (
        <StatusDot
          color="var(--system-blue)"
          title={`${item.title} updated`}
          data-mobile-working-set-moved=""
          className="absolute right-0 top-0 size-2 border-2 border-[var(--bg)] animate-[sidebar-pulse_1s_ease-in-out_4] motion-reduce:animate-none"
        />
      ) : null}
    </button>
  )
}

export function MobileWorkingSetNav({
  items,
  activeId,
  onSelect,
}: {
  items: MobileWorkingSetNavItem[]
  activeId: string | null
  onSelect: (sessionId: string) => void
}) {
  return (
    <nav data-mobile-working-set-nav aria-label="Open chats" className="flex min-w-0 items-center justify-center gap-1">
      {items.slice(0, 4).map((item) => {
        return (
          <WorkingSetChip
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onSelect}
          />
        )
      })}
    </nav>
  )
}
