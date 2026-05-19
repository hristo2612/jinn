
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  MessageSquare, Users, LayoutGrid, Clock,
  Activity, Zap, Settings, Plus, Hash,
} from "lucide-react"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { useSettings } from "@/routes/settings-provider"
import { useOrg } from "@/hooks/use-employees"
import { useCronJobs } from "@/hooks/use-cron"
import { useSessions } from "@/hooks/use-sessions"
import { useSkills } from "@/hooks/use-skills"

const RECENT_KEY = "jinn-command-recent"
const MAX_RECENT = 5

interface RecentItem {
  id: string
  label: string
  href: string
  type: string
}

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecent(item: RecentItem) {
  const items = loadRecent().filter(r => r.id !== item.id)
  items.unshift(item)
  localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)))
}

const STATIC_PAGES = [
  { id: "page-chat", label: "Chat", icon: MessageSquare, href: "/" },
  { id: "page-org", label: "Organization", icon: Users, href: "/org" },
  { id: "page-kanban", label: "Kanban", icon: LayoutGrid, href: "/kanban" },
  { id: "page-cron", label: "Cron", icon: Clock, href: "/cron" },
  { id: "page-logs", label: "Activity", icon: Activity, href: "/logs" },
  { id: "page-skills", label: "Skills", icon: Zap, href: "/skills" },
  { id: "page-settings", label: "Settings", icon: Settings, href: "/settings" },
]

export function GlobalSearch() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Jinn"
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const goTo = useNavigate()

  const { data: orgData } = useOrg()
  const { data: cronJobs } = useCronJobs()
  const { data: sessions } = useSessions()
  const { data: skills } = useSkills()

  // Cmd+K toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setOpen(prev => !prev)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  // Load recents when opened
  useEffect(() => {
    if (open) setRecents(loadRecent())
  }, [open])

  const navigate = useCallback((href: string, item: RecentItem) => {
    saveRecent(item)
    setOpen(false)
    goTo(href)
  }, [goTo])

  const employeeNames: string[] = Array.isArray(orgData?.employees)
    ? orgData.employees.map((e) => e.name)
    : []
  const crons = Array.isArray(cronJobs) ? cronJobs : []
  const sessionList = Array.isArray(sessions) ? sessions.slice(0, 10) : []
  const skillList = Array.isArray(skills) ? skills.slice(0, 10) : []

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 gap-0 max-w-[560px]">
          <Command className="rounded-lg">
            <CommandInput placeholder={`Search ${portalName}...`} />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>

              {/* Recent items */}
              {recents.length > 0 && (
                <>
                  <CommandGroup heading="Recent">
                    {recents.map(item => (
                      <CommandItem
                        key={item.id}
                        onSelect={() => navigate(item.href, item)}
                      >
                        <Hash size={16} className="mr-2 opacity-50" />
                        {item.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                </>
              )}

              {/* Pages */}
              <CommandGroup heading="Pages">
                {STATIC_PAGES.map(page => (
                  <CommandItem
                    key={page.id}
                    onSelect={() => navigate(page.href, { id: page.id, label: page.label, href: page.href, type: 'page' })}
                  >
                    <page.icon size={16} className="mr-2 opacity-50" />
                    {page.label}
                  </CommandItem>
                ))}
              </CommandGroup>

              {/* Actions */}
              <CommandGroup heading="Actions">
                <CommandItem onSelect={() => { setOpen(false); goTo('/') }}>
                  <Plus size={16} className="mr-2 opacity-50" />
                  New Chat
                </CommandItem>
              </CommandGroup>

              {/* Employees */}
              {employeeNames.length > 0 && (
                <CommandGroup heading="Employees">
                  {employeeNames.slice(0, 8).map((name) => (
                    <CommandItem
                      key={name}
                      onSelect={() => navigate('/org', { id: `emp-${name}`, label: name, href: '/org', type: 'employee' })}
                    >
                      <Users size={16} className="mr-2 opacity-50" />
                      {name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {/* Sessions */}
              {sessionList.length > 0 && (
                <CommandGroup heading="Recent Sessions">
                  {sessionList.map((session) => {
                    const id = String(session.id ?? '')
                    const title = String(session.title ?? session.id ?? '').slice(0, 50)
                    return (
                      <CommandItem
                        key={id}
                        onSelect={() => navigate('/', { id: `session-${id}`, label: title, href: '/', type: 'session' })}
                      >
                        <MessageSquare size={16} className="mr-2 opacity-50" />
                        {title}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}

              {/* Cron Jobs */}
              {crons.length > 0 && (
                <CommandGroup heading="Cron Jobs">
                  {crons.slice(0, 6).map((job) => {
                    const id = String(job.id ?? '')
                    const name = String(job.name ?? id)
                    return (
                      <CommandItem
                        key={id}
                        onSelect={() => navigate('/cron', { id: `cron-${id}`, label: name, href: '/cron', type: 'cron' })}
                      >
                        <Clock size={16} className="mr-2 opacity-50" />
                        {name}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}

              {/* Skills */}
              {skillList.length > 0 && (
                <CommandGroup heading="Skills">
                  {skillList.map((skill) => {
                    const name = String(skill.name ?? '')
                    return (
                      <CommandItem
                        key={name}
                        onSelect={() => navigate('/skills', { id: `skill-${name}`, label: name, href: '/skills', type: 'skill' })}
                      >
                        <Zap size={16} className="mr-2 opacity-50" />
                        {name}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
