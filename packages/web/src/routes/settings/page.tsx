
import { useEffect, useState } from "react"
import { RotateCcw, Trash2, Check, Save, Loader2, Plus, EyeOff } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/routes/settings-provider"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useTheme } from "@/routes/providers"
import { THEMES } from "@/lib/themes"
import type { ThemeId } from "@/lib/themes"
import { api } from "@/lib/api"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { useModelRegistry } from "@/hooks/use-model-registry"
import { useOnboarding } from "@/hooks/use-onboarding"
import { RemoteAccessPanel } from "@/components/auth/remote-access-panel"
import { useAuth } from "@/routes/auth-provider"
import { cn } from "@/lib/utils"
import { resolveTodoIdPrefix } from "@/lib/todo-id"
import {
  addModelOverride,
  hideModelOverride,
  resetEngineModelOverrides,
  showModelOverride,
} from "@/lib/model-config"

// ---------------------------------------------------------------------------
// Accent color presets
// ---------------------------------------------------------------------------

const ACCENT_PRESETS = [
  { label: "Red", value: "#EF4444" },
  { label: "Orange", value: "#F97316" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Yellow", value: "#EAB308" },
  { label: "Lime", value: "#84CC16" },
  { label: "Green", value: "#22C55E" },
  { label: "Emerald", value: "#10B981" },
  { label: "Cyan", value: "#06B6D4" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Indigo", value: "#6366F1" },
  { label: "Violet", value: "#8B5CF6" },
  { label: "Pink", value: "#EC4899" },
]

// ---------------------------------------------------------------------------
// Config type (gateway API)
// ---------------------------------------------------------------------------

interface Config {
  gateway?: { port?: number; host?: string }
  engines?: {
    default?: string
    claude?: { bin?: string; model?: string; effortLevel?: string }
    codex?: { bin?: string; model?: string; effortLevel?: string }
    grok?: { bin?: string; model?: string; effortLevel?: string }
  }
  sessions?: {
    interruptOnNewMessage?: boolean
    rateLimitStrategy?: "wait" | "fallback"
    fallbackEngine?: "codex"
  }
  connectors?: {
    slack?: {
      appToken?: string
      botToken?: string
      shareSessionInChannel?: boolean
      allowFrom?: string | string[]
      ignoreOldMessagesOnBoot?: boolean
    }
    discord?: {
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
    }
    telegram?: {
      botToken?: string
      allowFrom?: number[]
      ignoreOldMessagesOnBoot?: boolean
    }
    whatsapp?: {
      authDir?: string
      allowFrom?: string[]
    }
    web?: Record<string, never>
    instances?: Array<{
      id: string
      type: "discord" | "slack" | "whatsapp" | "telegram"
      employee?: string
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
      appToken?: string
      authDir?: string
      ignoreOldMessagesOnBoot?: boolean
      [key: string]: unknown
    }>
  }
  logging?: {
    level?: string
    stdout?: boolean
    file?: boolean
  }
  models?: Record<string, {
    default?: string
    effortMechanism?: string
    hidden?: string[]
    models: Array<{
      id: string
      label?: string
      supportsEffort?: boolean
      effortLevels?: string[]
      contextWindow?: number
    }>
  }>
  cron?: {
    defaultDelivery?: { connector?: string; channel?: string }
  }
  portal?: {
    companyName?: string
    companyPrefix?: string
    portalName?: string
    operatorName?: string
  }
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Section wrapper using CSS variable styling
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-7">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] px-[var(--space-3)] pb-[var(--space-2)]"
      >
        {title}
      </div>
      {/* Grouped-inset card (shared visual language): --bg-secondary carrying
          the card shadow — no hairline ring at rest. */}
      <div
        className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-4)] shadow-[var(--shadow-card)]"
      >
        {children}
      </div>
    </section>
  )
}

// One control recipe for every text input and select on the page: soft
// --fill-tertiary well, no border at rest, accent focus ring (mirrors
// .apple-input, sized for dense form rows).
const CONTROL_CLASS =
  "w-full rounded-[10px] border-none bg-[var(--fill-tertiary)] px-[12px] py-[7px] " +
  "text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none " +
  "placeholder:text-[var(--text-tertiary)] transition-[box-shadow] duration-150 " +
  "focus:shadow-[0_0_0_3px_var(--accent-fill)]"

function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col items-stretch gap-[var(--space-2)] py-[var(--space-2)] sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--space-4)]"
    >
      <label
        className="shrink-0 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
      >
        {label}
      </label>
      <div className="min-w-0 w-full sm:w-[240px] sm:shrink-0">{children}</div>
    </div>
  )
}

function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={CONTROL_CLASS}
    />
  )
}

function SettingsSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${CONTROL_CLASS} cursor-pointer`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-[44px] h-[24px] rounded-[12px] border-none cursor-pointer relative shrink-0 transition-[background] duration-200 ease-[var(--ease-smooth)]"
      style={{
        background: checked ? "var(--system-green)" : "var(--fill-primary)",
      }}
    >
      <span
        className="absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-[var(--ease-spring)]"
        style={{
          left: checked ? 22 : 2,
        }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Whisper STT language list (curated top ~35)
// ---------------------------------------------------------------------------

const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
}

// ---------------------------------------------------------------------------
// Voice Input (STT) settings section — self-contained state
// ---------------------------------------------------------------------------

function SttSettingsSection() {
  const [status, setStatus] = useState<{
    available: boolean
    model: string | null
    downloading: boolean
    progress: number
    languages: string[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [addLang, setAddLang] = useState("")

  useEffect(() => {
    api.sttStatus().then(setStatus).catch(() => {})
  }, [])

  // Poll for download progress
  useEffect(() => {
    if (!status?.downloading) return
    const timer = setInterval(() => {
      api.sttStatus().then(setStatus).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [status?.downloading])

  function handleRemoveLanguage(code: string) {
    if (!status || status.languages.length <= 1) return
    const next = status.languages.filter((l) => l !== code)
    setSaving(true)
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleAddLanguage() {
    if (!addLang || !status || status.languages.includes(addLang)) return
    const next = [...status.languages, addLang]
    setSaving(true)
    setAddLang("")
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  function handleDownload() {
    api.sttDownload()
      .then(() => setStatus((prev) => prev ? { ...prev, downloading: true, progress: 0 } : prev))
      .catch(() => {})
  }

  if (!status) return null

  const availableLangs = Object.entries(WHISPER_LANGUAGES)
    .filter(([code]) => !status.languages.includes(code))
    .sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <Section title="Voice Input">
      {/* Status row */}
      <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
        <div
          className="w-[8px] h-[8px] rounded-full shrink-0"
          style={{
            background: status.available ? "var(--system-green)" : "var(--system-red)",
          }}
        />
        <div className="flex-1">
          <div className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
            {status.available
              ? `Whisper ${(status.model || "small").charAt(0).toUpperCase() + (status.model || "small").slice(1)}`
              : "No model installed"}
          </div>
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {status.available
              ? "Offline speech recognition ready"
              : "Download a model to enable voice input"}
          </div>
        </div>
      </div>

      {/* Download section */}
      {!status.available && !status.downloading && (
        <button
          onClick={handleDownload}
          className="w-full p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] mb-[var(--space-4)]"
        >
          Download Whisper Small (~500MB)
        </button>
      )}

      {/* Download progress */}
      {status.downloading && (
        <div className="mb-[var(--space-4)]">
          <div className="flex justify-between mb-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            <span>Downloading model…</span>
            <span>{status.progress}%</span>
          </div>
          <div className="h-[6px] rounded-[3px] bg-[var(--fill-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{
                width: `${status.progress}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Languages section — only when model is available */}
      {status.available && (
        <>
          <div className="border-t border-[var(--separator)] mt-[var(--space-2)] pt-[var(--space-3)]">
            <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Transcription Languages
            </div>
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
              First language is the default. Add multiple to show a language picker in chat.
            </div>

            {/* Language chips */}
            <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
              {status.languages.map((code) => (
                <div
                  key={code}
                  className="inline-flex items-center gap-[var(--space-1)] px-[8px] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-primary)]"
                >
                  <span className="font-[family-name:var(--font-mono)] uppercase text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] mr-[2px]">
                    {code}
                  </span>
                  {WHISPER_LANGUAGES[code] || code}
                  {status.languages.length > 1 && (
                    <button
                      onClick={() => handleRemoveLanguage(code)}
                      disabled={saving}
                      aria-label={`Remove ${WHISPER_LANGUAGES[code] || code}`}
                      className="bg-none border-none cursor-pointer p-0 ml-[2px] text-[var(--text-quaternary)] text-[14px] leading-none flex items-center"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add language */}
            <div className="flex gap-[var(--space-2)]">
              <select
                value={addLang}
                onChange={(e) => setAddLang(e.target.value)}
                className={cn(CONTROL_CLASS, "flex-1 cursor-pointer")}
                style={{
                  color: addLang ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
              >
                <option value="">Add a language…</option>
                {availableLangs.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()} — {name}
                  </option>
                ))}
              </select>
              <button
                onClick={handleAddLanguage}
                disabled={!addLang || saving}
                className="px-[14px] py-[6px] rounded-[var(--radius-sm)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shrink-0"
                style={{
                  background: addLang ? "var(--accent)" : "var(--fill-tertiary)",
                  color: addLang ? "var(--accent-contrast)" : "var(--text-quaternary)",
                  cursor: addLang ? "pointer" : "default",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  useBreadcrumbs([{ label: 'Settings' }])
  const {
    settings,
    setAccentColor,
    setCompanyName,
    setPortalName,
    setPortalSubtitle,
    setOperatorName,
    setPortalEmoji,
    setLanguage,
    resetAll,
  } = useSettings()
  const { theme, setTheme } = useTheme()
  const auth = useAuth()

  // Local branding inputs
  const [companyNameValue, setCompanyNameValue] = useState(settings.companyName ?? "")
  const [companyPrefixValue, setCompanyPrefixValue] = useState("")
  const { data: onboarding } = useOnboarding()
  const companyPrefixFrozen = onboarding?.todoPrefixFrozen === true
  const companyPrefixPreview = companyPrefixFrozen
    ? onboarding?.todoPrefix ?? null
    : resolveTodoIdPrefix(companyNameValue, companyPrefixValue || undefined)
  const [nameValue, setNameValue] = useState(settings.portalName ?? "")
  const [subtitleValue, setSubtitleValue] = useState(settings.portalSubtitle ?? "")
  const [operatorNameValue, setOperatorNameValue] = useState(settings.operatorName ?? "")
  const [emojiValue, setEmojiValue] = useState(settings.portalEmoji ?? "")
  const [languageValue, setLanguageValue] = useState(settings.language ?? "English")
  const [customHex, setCustomHex] = useState(settings.accentColor ?? "")
  const [showCooEmojiPicker, setShowCooEmojiPicker] = useState(false)
  const [claudeModelId, setClaudeModelId] = useState("")
  const [claudeModelLabel, setClaudeModelLabel] = useState("")

  // Model/capability registry — drives the model + effort dropdowns (no hardcoded lists).
  const { data: modelRegistry } = useModelRegistry()
  const modelOptions = (engine: string, fallback: Array<{ value: string; label: string }>) => {
    const models = modelRegistry?.engines?.[engine]?.models ?? []
    return models.length ? models.map((m) => ({ value: m.id, label: m.label })) : fallback
  }
  const effortOptions = (engine: string, fallback: Array<{ value: string; label: string }>) => {
    const levels = Array.from(new Set((modelRegistry?.engines?.[engine]?.models ?? []).flatMap((m) => m.effortLevels)))
    return levels.length
      ? [{ value: "default", label: "Default" }, ...levels.map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) }))]
      : fallback
  }

  // Gateway config state
  const [config, setConfig] = useState<Config>({})
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    type: "success" | "error"
    message: string
  } | null>(null)

  // WhatsApp QR code state
  const [waQr, setWaQr] = useState<string | null>(null)
  const [waStatus, setWaStatus] = useState<string>("unknown")

  // Employees list for instance binding
  const [employees, setEmployees] = useState<Array<{name: string, displayName: string}>>([])

  useEffect(() => {
    api.getOrg().then((org: any) => {
      if (org?.employees) {
        setEmployees(org.employees.map((e: any) => typeof e === 'string' ? { name: e, displayName: e } : { name: e.name, displayName: e.displayName || e.name }))
      }
    }).catch(() => {})
  }, [])

  // Sync local values when settings change externally (e.g., reset)
  useEffect(() => {
    setCompanyNameValue(settings.companyName ?? "")
    setNameValue(settings.portalName ?? "")
    setSubtitleValue(settings.portalSubtitle ?? "")
    setOperatorNameValue(settings.operatorName ?? "")
    setEmojiValue(settings.portalEmoji ?? "")
    setLanguageValue(settings.language ?? "English")
    setCustomHex(settings.accentColor ?? "")
  }, [
    settings.companyName,
    settings.portalName,
    settings.portalSubtitle,
    settings.operatorName,
    settings.portalEmoji,
    settings.language,
    settings.accentColor,
  ])

  // Load gateway config
  function loadConfig() {
    setConfigLoading(true)
    api
      .getConfig()
      .then((data) => {
        setConfig(data as Config)
        setCompanyPrefixValue((data as Config).portal?.companyPrefix ?? "")
        setConfigError(null)
      })
      .catch((err) => setConfigError(err.message))
      .finally(() => setConfigLoading(false))
  }

  useEffect(() => {
    loadConfig()
  }, [])

  // Poll for WhatsApp QR code when WhatsApp connector is configured
  useEffect(() => {
    if (!config.connectors?.whatsapp) return

    let cancelled = false

    async function checkQr() {
      try {
        const statusRes = await fetch("/api/status")
        const status = await statusRes.json()
        const connStatus = status?.connectors?.whatsapp?.status
        if (!cancelled) setWaStatus(connStatus ?? "unknown")

        if (connStatus === "qr_pending") {
          const qrRes = await fetch("/api/connectors/whatsapp/qr")
          const data = await qrRes.json()
          if (!cancelled) setWaQr(data.qr)
        } else {
          if (!cancelled) setWaQr(null)
        }
      } catch {
        // non-fatal
      }
    }

    void checkQr()
    const interval = setInterval(() => { void checkQr() }, 10000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [config.connectors?.whatsapp])

  function updateConfig(path: string[], value: unknown) {
    setConfig((prev) => {
      const next = structuredClone(prev)
      let obj: Record<string, unknown> = next
      for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]] || typeof obj[path[i]] !== "object") {
          obj[path[i]] = {}
        }
        obj = obj[path[i]] as Record<string, unknown>
      }
      obj[path[path.length - 1]] = value
      return next
    })
  }

  function applyModelConfig(updater: (cfg: Config) => Config) {
    setConfig((prev) => updater(prev))
  }

  const claudeRegistryModels = modelRegistry?.engines?.claude?.models ?? []
  const hiddenClaudeIds = config.models?.claude?.hidden ?? []
  const registryClaudeIds = new Set(claudeRegistryModels.map((m) => m.id))
  const customClaudeModels = (config.models?.claude?.models ?? []).filter((m) => !registryClaudeIds.has(m.id))
  const claudeEffortDefaults = Array.from(new Set(claudeRegistryModels.flatMap((m) => m.effortLevels)))
  const visibleClaudeModels = claudeRegistryModels.filter((m) => !hiddenClaudeIds.includes(m.id))
  const hiddenClaudeModels = hiddenClaudeIds.map((id) => claudeRegistryModels.find((m) => m.id === id) ?? { id, label: id })

  function addClaudeModel() {
    if (!claudeModelId.trim()) return
    applyModelConfig((prev) => addModelOverride(prev, "claude", {
      id: claudeModelId,
      label: claudeModelLabel,
      effortLevels: claudeEffortDefaults,
    }))
    setClaudeModelId("")
    setClaudeModelLabel("")
  }

  function handleSave() {
    setSaving(true)
    setFeedback(null)
    api
      .updateConfig(config)
      .then(() =>
        setFeedback({ type: "success", message: "Settings saved successfully" })
      )
      .catch((err) =>
        setFeedback({
          type: "error",
          message: `Failed to save: ${err.message}`,
        })
      )
      .finally(() => setSaving(false))
  }

  return (
    <PageLayout>
      {/* Same page frame as Todos/Limits: one scrolling column, inline
          large-title header. Forms read best narrow, so the column is 640px. */}
      <div className="h-full overflow-y-auto" data-scrollable>
        <div className="mx-auto max-w-[640px] px-5 pb-20 pt-6 md:pt-11">
          <header className="mb-6">
            <h1 className="font-[var(--font-display)] text-[length:var(--text-title1)] font-bold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] md:text-[length:var(--text-large-title)]">
              Settings
            </h1>
            <div className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              Portal, gateway and connectors
            </div>
          </header>

          {/* -- Section 1: Appearance -- */}
          <Section title="Appearance">
            {/* Theme picker */}
            <div
              className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]"
            >
              Theme
            </div>
            <div
              className="grid grid-cols-3 gap-[var(--space-2)] mb-[var(--space-4)]"
            >
              {THEMES.map((t) => {
                const isActive = theme === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    aria-pressed={isActive}
                    className="flex cursor-pointer flex-col items-center gap-[var(--space-1)] rounded-[13px] border-none px-[var(--space-2)] py-[var(--space-3)] transition-colors duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      background: isActive ? "var(--accent-fill)" : "var(--fill-quaternary)",
                    }}
                  >
                    <span className="text-[24px]">{t.emoji}</span>
                    <span
                      className="text-[length:var(--text-caption2)]"
                      style={{
                        fontWeight: isActive
                          ? "var(--weight-semibold)"
                          : "var(--weight-medium)",
                        color: isActive
                          ? "var(--accent)"
                          : "var(--text-secondary)",
                      }}
                    >
                      {t.label}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Accent color */}
            <div
              className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]"
            >
              Accent Color
            </div>
            <div
              className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]"
            >
              {ACCENT_PRESETS.map((preset) => {
                const isActive = settings.accentColor === preset.value
                return (
                  <button
                    key={preset.value}
                    onClick={() => setAccentColor(preset.value)}
                    aria-label={preset.label}
                    aria-pressed={isActive}
                    title={preset.label}
                    className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full border-none transition-transform duration-100 ease-[var(--ease-smooth)] hover:scale-105"
                    style={{
                      background: preset.value,
                      // Selection ring floats off the swatch on a bg-colored gap —
                      // a control affordance, not a resting hairline.
                      boxShadow: isActive
                        ? `0 0 0 2px var(--bg-secondary), 0 0 0 4px ${preset.value}`
                        : "none",
                    }}
                  >
                    {isActive && (
                      <Check size={14} color="#fff" strokeWidth={3} />
                    )}
                  </button>
                )
              })}
            </div>

            {/* Custom hex input */}
            <div
              className="flex items-center gap-[var(--space-3)]"
            >
              <label
                className="flex items-center gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] cursor-pointer"
              >
                Custom:
                <input
                  type="color"
                  value={settings.accentColor ?? "#3B82F6"}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="w-[28px] h-[28px] border-none rounded-full cursor-pointer bg-transparent p-0"
                />
              </label>
              <input
                type="text"
                placeholder="#3B82F6"
                value={customHex}
                onChange={(e) => {
                  setCustomHex(e.target.value)
                  if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
                    setAccentColor(e.target.value)
                  }
                }}
                className={cn(CONTROL_CLASS, "w-[96px] font-mono text-[length:var(--text-caption1)]")}
              />
              {settings.accentColor && (
                <button
                  onClick={() => setAccentColor(null)}
                  className="text-[length:var(--text-footnote)] text-[var(--system-blue)] bg-none border-none cursor-pointer p-0 inline-flex items-center gap-[4px]"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
              )}
            </div>
          </Section>

          {/* -- Section 2: Branding -- */}
          <Section title="Branding">
            <div
              className="flex flex-col gap-[var(--space-3)]"
            >
              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Company Name
                </label>
                <input
                  type="text"
                  className={CONTROL_CLASS}
                  placeholder="Acme Labs"
                  value={companyNameValue}
                  onChange={(e) => setCompanyNameValue(e.target.value)}
                  onBlur={() => {
                    if (!companyPrefixPreview) return
                    setCompanyName(companyNameValue)
                    api.completeOnboarding({
                      companyName: companyNameValue,
                      ...(!companyPrefixFrozen && { companyPrefix: companyPrefixValue || null }),
                    }).catch(() => {})
                  }}
                />
                <label className="mt-[var(--space-3)] block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                  Todo Prefix Override
                </label>
                <input
                  type="text"
                  maxLength={3}
                  className={`${CONTROL_CLASS} uppercase disabled:opacity-60`}
                  placeholder="Optional, e.g. JNN"
                  value={companyPrefixFrozen ? onboarding?.todoPrefix ?? "" : companyPrefixValue}
                  disabled={companyPrefixFrozen}
                  onChange={(e) => setCompanyPrefixValue(e.target.value.toUpperCase())}
                  onBlur={() => {
                    if (!companyPrefixPreview || companyPrefixFrozen) return
                    api.completeOnboarding({
                      companyName: companyNameValue,
                      companyPrefix: companyPrefixValue || null,
                    }).catch(() => {})
                  }}
                />
                <p className={`mt-[var(--space-1)] text-[length:var(--text-caption1)] ${companyPrefixPreview ? "text-[var(--text-secondary)]" : "text-[var(--system-red)]"}`}>
                  {companyPrefixPreview
                    ? companyPrefixFrozen
                      ? `Todo IDs use ${companyPrefixPreview}-1, ${companyPrefixPreview}-2, ... This prefix was frozen by the first Todo and cannot be changed.`
                      : `"${companyNameValue}" produces ${companyPrefixPreview}-1, ${companyPrefixPreview}-2, ... It cannot be changed after the first Todo.`
                    : companyPrefixValue
                      ? "The override must be exactly three uppercase Latin letters."
                      : "Enter a company name with at least three Latin letters."}
                </p>
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Name
                </label>
                <input
                  type="text"
                  className={CONTROL_CLASS}
                  placeholder="Jinn"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={() => {
                    setPortalName(nameValue || null)
                    api.completeOnboarding({ portalName: nameValue || undefined }).catch(() => {})
                  }}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Subtitle
                </label>
                <input
                  type="text"
                  className={CONTROL_CLASS}
                  placeholder="Command Centre"
                  value={subtitleValue}
                  onChange={(e) => setSubtitleValue(e.target.value)}
                  onBlur={() => setPortalSubtitle(subtitleValue || null)}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Operator Name
                </label>
                <input
                  type="text"
                  className={CONTROL_CLASS}
                  placeholder="Your Name"
                  value={operatorNameValue}
                  onChange={(e) => setOperatorNameValue(e.target.value)}
                  onBlur={() => {
                    setOperatorName(operatorNameValue || null)
                    api.completeOnboarding({ operatorName: operatorNameValue || undefined }).catch(() => {})
                  }}
                />
              </div>

              {/* Portal emoji \u2014 one control instead of the old duplicate pair
                  (a picker section + a raw text input both writing the same
                  setting). The button opens the searchable picker; the small
                  field still accepts free-form marks (letters, custom glyphs). */}
              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Emoji
                </label>
                <div className="relative flex items-center gap-[var(--space-3)]">
                  <button
                    type="button"
                    onClick={() => setShowCooEmojiPicker(!showCooEmojiPicker)}
                    aria-label="Choose portal emoji"
                    aria-expanded={showCooEmojiPicker}
                    className="flex size-[44px] cursor-pointer items-center justify-center rounded-[13px] border-none bg-[var(--fill-quaternary)] text-[26px] leading-none transition-colors hover:bg-[var(--fill-tertiary)]"
                  >
                    {settings.portalEmoji ?? "\u{1F9DE}"}
                  </button>
                  <input
                    type="text"
                    className={cn(CONTROL_CLASS, "w-[96px] text-center")}
                    placeholder={"\u{1F9DE}\u{FE0F}"}
                    value={emojiValue}
                    onChange={(e) => setEmojiValue(e.target.value)}
                    onBlur={() => setPortalEmoji(emojiValue || null)}
                  />
                  {showCooEmojiPicker && (
                    <EmojiPicker
                      current={settings.portalEmoji ?? "\u{1F9DE}"}
                      onSelect={(emoji) => {
                        setPortalEmoji(emoji)
                        setShowCooEmojiPicker(false)
                      }}
                      onClose={() => setShowCooEmojiPicker(false)}
                    />
                  )}
                </div>
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Language
                </label>
                <select
                  value={languageValue}
                  onChange={(e) => setLanguageValue(e.target.value)}
                  onBlur={() => {
                    setLanguage(languageValue || "English")
                    api.completeOnboarding({ language: languageValue || undefined }).catch(() => {})
                  }}
                  className={`${CONTROL_CLASS} cursor-pointer`}
                >
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                  <option value="French">French</option>
                  <option value="German">German</option>
                  <option value="Portuguese">Portuguese</option>
                  <option value="Italian">Italian</option>
                  <option value="Dutch">Dutch</option>
                  <option value="Russian">Russian</option>
                  <option value="Chinese">Chinese</option>
                  <option value="Japanese">Japanese</option>
                  <option value="Korean">Korean</option>
                  <option value="Arabic">Arabic</option>
                  <option value="Hindi">Hindi</option>
                  <option value="Bulgarian">Bulgarian</option>
                </select>
              </div>
            </div>
          </Section>

          {/* -- Pairing -- */}
          <Section title="Pairing">
            <RemoteAccessPanel
              authState={auth.authState}
              devices={auth.devices}
              onCreatePairingCode={auth.createPairingCode}
              onLogout={auth.logout}
              onUnpairDevice={auth.unpairDevice}
            />
          </Section>

          {/* Gateway config feedback */}
          {feedback && (
            <div
              className="mb-[var(--space-4)] rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)]"
              style={{
                background: `color-mix(in srgb, ${
                  feedback.type === "success" ? "var(--system-green)" : "var(--system-red)"
                } 8%, transparent)`,
                color:
                  feedback.type === "success"
                    ? "var(--system-green)"
                    : "var(--system-red)",
              }}
            >
              {feedback.message}
            </div>
          )}

          {configLoading ? (
            <div
              className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-footnote)]"
            >
              <Loader2
                size={20}
                className="mx-auto mb-[var(--space-2)] animate-spin"
              />
              Loading gateway config...
            </div>
          ) : configError ? (
            <div
              className="mb-[var(--space-6)] rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
            >
              Failed to load config: {configError}
            </div>
          ) : (
            <>
              {/* -- Section 3: Gateway Configuration -- */}
              <Section title="Gateway Configuration">
                <FieldRow label="Port">
                  <SettingsInput
                    type="number"
                    value={String(config.gateway?.port ?? "")}
                    onChange={(v) =>
                      updateConfig(["gateway", "port"], Number(v) || 0)
                    }
                    placeholder="7777"
                  />
                </FieldRow>
                <FieldRow label="Host">
                  <SettingsInput
                    value={config.gateway?.host ?? ""}
                    onChange={(v) => updateConfig(["gateway", "host"], v)}
                    placeholder="127.0.0.1"
                  />
                </FieldRow>
                <FieldRow label="Default Engine">
                  <SettingsSelect
                    value={config.engines?.default ?? "claude"}
                    onChange={(v) => updateConfig(["engines", "default"], v)}
                    options={[
                      { value: "claude", label: "Claude" },
                      { value: "codex", label: "Codex" },
                      { value: "grok", label: "Grok" },
                    ]}
                  />
                </FieldRow>
              </Section>

              {/* -- Section 4: Engine Configuration -- */}
              <Section title="Engine Configuration">
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Claude
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.claude?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "bin"], v)
                    }
                    placeholder="claude"
                  />
                </FieldRow>
                <FieldRow label="Model">
                  <SettingsSelect
                    value={config.engines?.claude?.model ?? "opus"}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "model"], v)
                    }
                    options={modelOptions("claude", [
                      { value: "claude-fable-5", label: "Fable 5" },
                      { value: "opus", label: "Opus" },
                      { value: "sonnet", label: "Sonnet" },
                      { value: "haiku", label: "Haiku" },
                    ])}
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.claude?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "effortLevel"], v)
                    }
                    options={effortOptions("claude", [
                      { value: "default", label: "Default" },
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                    ])}
                  />
                </FieldRow>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                >
                  <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-2)]">
                    <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
                      Claude Models
                    </div>
                    <button
                      type="button"
                      onClick={() => applyModelConfig((prev) => resetEngineModelOverrides(prev, "claude"))}
                      className="inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-none bg-[var(--fill-tertiary)] px-[8px] py-[5px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] cursor-pointer hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
                    >
                      <RotateCcw size={13} />
                      Reset
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-[var(--space-2)] sm:grid-cols-[1fr_1fr_auto]">
                    <SettingsInput
                      value={claudeModelId}
                      onChange={setClaudeModelId}
                      placeholder="claude-sonnet-4-6"
                    />
                    <SettingsInput
                      value={claudeModelLabel}
                      onChange={setClaudeModelLabel}
                      placeholder="Sonnet 4.6"
                    />
                    <button
                      type="button"
                      onClick={addClaudeModel}
                      disabled={!claudeModelId.trim()}
                      className="inline-flex items-center justify-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-none bg-[var(--accent)] px-[10px] py-[6px] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:cursor-default disabled:opacity-50"
                    >
                      <Plus size={14} />
                      Add
                    </button>
                  </div>

                  {visibleClaudeModels.length > 0 && (
                    <div className="mt-[var(--space-3)] space-y-[var(--space-1)]">
                      {visibleClaudeModels.map((m) => (
                        <div key={m.id} className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] px-[8px] py-[6px]">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-primary)]">{m.label}</div>
                            <div className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">{m.id}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => applyModelConfig((prev) => hideModelOverride(prev, "claude", m.id))}
                            aria-label={`Hide ${m.label}`}
                            className="inline-flex size-[28px] items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
                          >
                            <EyeOff size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {hiddenClaudeModels.length > 0 && (
                    <div className="mt-[var(--space-2)] flex flex-wrap gap-[var(--space-2)]">
                      {hiddenClaudeModels.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => applyModelConfig((prev) => showModelOverride(prev, "claude", m.id))}
                          className="rounded-[var(--radius-sm)] border-none bg-[var(--fill-tertiary)] px-[8px] py-[4px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] cursor-pointer hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
                        >
                          Restore {m.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {customClaudeModels.length > 0 && (
                    <div className="mt-[var(--space-2)] flex flex-wrap gap-[var(--space-2)]">
                      {customClaudeModels.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            applyModelConfig((prev) => {
                              const next = structuredClone(prev)
                              const block = next.models?.claude
                              if (block) block.models = block.models.filter((entry) => entry.id !== m.id)
                              return next
                            })
                          }}
                          className="inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-none bg-[var(--fill-tertiary)] px-[8px] py-[4px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] cursor-pointer hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]"
                        >
                          <Trash2 size={13} />
                          {m.label || m.id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Codex
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.codex?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "bin"], v)
                    }
                    placeholder="codex"
                  />
                </FieldRow>
                <FieldRow label="Model">
                  <SettingsSelect
                    value={config.engines?.codex?.model ?? "gpt-5.5"}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "model"], v)
                    }
                    options={modelOptions("codex", [
                      { value: "gpt-5.5", label: "GPT-5.5" },
                      { value: "gpt-5.4", label: "GPT-5.4" },
                      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
                      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
                      { value: "gpt-5.2", label: "GPT-5.2" },
                      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
                      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
                    ])}
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.codex?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "effortLevel"], v)
                    }
                    options={effortOptions("codex", [
                      { value: "default", label: "Default" },
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                      { value: "xhigh", label: "Extra High" },
                    ])}
                  />
                </FieldRow>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Grok
                </div>
                <FieldRow label="Binary Path">
                  <SettingsInput
                    value={config.engines?.grok?.bin ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "grok", "bin"], v)
                    }
                    placeholder="grok"
                  />
                </FieldRow>
                <FieldRow label="Model">
                  <SettingsSelect
                    value={config.engines?.grok?.model ?? "grok-build"}
                    onChange={(v) =>
                      updateConfig(["engines", "grok", "model"], v)
                    }
                    options={modelOptions("grok", [
                      { value: "grok-build", label: "Grok Build" },
                      { value: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast" },
                    ])}
                  />
                </FieldRow>
              </Section>

              {/* -- Section 5: Sessions -- */}
              <Section title="Sessions">
                <FieldRow label="Interrupt on New Message">
                  <ToggleSwitch
                    checked={config.sessions?.interruptOnNewMessage ?? true}
                    onChange={(v) =>
                      updateConfig(["sessions", "interruptOnNewMessage"], v)
                    }
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[4px]"
                >
                  When enabled, sending a new message to a running session will stop the
                  current agent and start processing your new message immediately. When
                  disabled, messages are queued.
                </div>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <FieldRow label="When Claude Hits Usage Limit">
                  <SettingsSelect
                    value={config.sessions?.rateLimitStrategy ?? "fallback"}
                    onChange={(v) =>
                      updateConfig(["sessions", "rateLimitStrategy"], v)
                    }
                    options={[
                      { value: "wait", label: "Wait & Auto-Resume" },
                      { value: "fallback", label: "Switch to GPT (Codex)" },
                    ]}
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[4px]"
                >
                  "Wait" pauses the session and continues automatically when Claude resets.
                  "Switch" answers immediately using GPT, then returns to Claude once the reset window passes.
                </div>
              </Section>

              {/* -- Section 6: Connectors -- */}
              <Section title="Connectors">
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Slack
                </div>
                <FieldRow label="App Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.slack?.appToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "appToken"], v)
                    }
                    placeholder="xapp-..."
                  />
                </FieldRow>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.slack?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "botToken"], v)
                    }
                    placeholder="xoxb-..."
                  />
                </FieldRow>
                <FieldRow label="Share Session in Channel">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.shareSessionInChannel ?? false}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "shareSessionInChannel"], v)
                    }
                  />
                </FieldRow>
                <FieldRow label="Allowed Users">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.slack?.allowFrom)
                      ? config.connectors?.slack?.allowFrom?.join(", ")
                      : config.connectors?.slack?.allowFrom ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "slack", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="U123, U456"
                  />
                </FieldRow>
                <FieldRow label="Ignore Old Messages on Boot">
                  <ToggleSwitch
                    checked={config.connectors?.slack?.ignoreOldMessagesOnBoot ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "slack", "ignoreOldMessagesOnBoot"], v)
                    }
                  />
                </FieldRow>

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Discord
                </div>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.discord?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "botToken"], v)
                    }
                    placeholder="Bot token..."
                  />
                </FieldRow>
                <FieldRow label="Allow From">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.discord?.allowFrom)
                      ? config.connectors?.discord?.allowFrom?.join(", ")
                      : config.connectors?.discord?.allowFrom ?? ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "discord", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="User IDs, comma-separated (optional)"
                  />
                </FieldRow>
                <FieldRow label="Guild ID">
                  <SettingsInput
                    value={config.connectors?.discord?.guildId ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "guildId"], v.trim() || undefined)
                    }
                    placeholder="Server/Guild ID (optional)"
                  />
                </FieldRow>
                <FieldRow label="Channel ID">
                  <SettingsInput
                    value={config.connectors?.discord?.channelId ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "discord", "channelId"], v.trim() || undefined)
                    }
                    placeholder="Restrict to this channel (right-click → Copy Channel ID)"
                  />
                </FieldRow>

                {/* Telegram */}
                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Telegram
                </div>
                <FieldRow label="Bot Token">
                  <SettingsInput
                    type="password"
                    value={config.connectors?.telegram?.botToken ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "telegram", "botToken"], v)
                    }
                    placeholder="123456:ABC-DEF..."
                  />
                </FieldRow>
                <FieldRow label="Allow From (User IDs)">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.telegram?.allowFrom)
                      ? config.connectors?.telegram?.allowFrom?.join(", ")
                      : ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "telegram", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => Number(entry.trim())).filter((n) => !isNaN(n)) : undefined,
                      )
                    }
                    placeholder="Telegram user IDs, comma-separated (optional)"
                  />
                </FieldRow>
                <FieldRow label="Ignore Old Messages on Boot">
                  <ToggleSwitch
                    checked={config.connectors?.telegram?.ignoreOldMessagesOnBoot ?? true}
                    onChange={(v) =>
                      updateConfig(["connectors", "telegram", "ignoreOldMessagesOnBoot"], v)
                    }
                  />
                </FieldRow>

                {/* WhatsApp */}
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mt-[var(--space-4)] mb-[var(--space-2)]"
                >
                  WhatsApp
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
                >
                  On first start, scan the QR code below with your WhatsApp app to connect. Credentials are cached for subsequent runs.
                </div>
                <FieldRow label="Auth Directory">
                  <SettingsInput
                    value={config.connectors?.whatsapp?.authDir ?? ""}
                    onChange={(v) =>
                      updateConfig(["connectors", "whatsapp", "authDir"], v.trim() || undefined)
                    }
                    placeholder="Default: ~/.jinn/.whatsapp-auth"
                  />
                </FieldRow>
                <FieldRow label="Allow From">
                  <SettingsInput
                    value={Array.isArray(config.connectors?.whatsapp?.allowFrom)
                      ? config.connectors?.whatsapp?.allowFrom?.join(", ")
                      : ""}
                    onChange={(v) =>
                      updateConfig(
                        ["connectors", "whatsapp", "allowFrom"],
                        v.trim() ? v.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
                      )
                    }
                    placeholder="447700900000@s.whatsapp.net, ... (optional)"
                  />
                </FieldRow>

                {waQr && (
                  <div
                    className="mt-[var(--space-3)] flex flex-col items-center gap-[var(--space-2)]"
                  >
                    <div
                      className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-secondary)]"
                    >
                      Scan with WhatsApp to connect
                    </div>
                    <img
                      src={waQr}
                      alt="WhatsApp QR Code"
                      className="h-[200px] w-[200px] rounded-[var(--radius-md)] bg-white p-[8px] shadow-[var(--shadow-subtle)]"
                    />
                    <div
                      className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
                    >
                      Open WhatsApp → Linked Devices → Link a Device
                    </div>
                  </div>
                )}
                {config.connectors?.whatsapp && waStatus === "ok" && (
                  <div
                    className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-green)] font-semibold"
                  >
                    ✓ Connected
                  </div>
                )}

                {/* Connector Instances */}
                <div className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]" />
                <div className="flex items-center justify-between mb-[var(--space-2)]">
                  <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
                    Connector Instances
                  </div>
                  <div className="flex items-center gap-[var(--space-2)]">
                    <button
                      className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors flex items-center gap-1"
                      onClick={async () => {
                        try {
                          const result = await api.reloadConnectors()
                          const parts: string[] = []
                          if (result.stopped.length) parts.push(`Stopped: ${result.stopped.join(", ")}`)
                          if (result.started.length) parts.push(`Started: ${result.started.join(", ")}`)
                          if (result.errors.length) parts.push(`Errors: ${result.errors.join(", ")}`)
                          alert(parts.length ? parts.join("\n") : "No connector instances to reload")
                        } catch {
                          alert("Failed to reload connectors")
                        }
                      }}
                    >
                      <RotateCcw size={12} />
                      Reload
                    </button>
                    <button
                      className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent)] hover:opacity-80 transition-opacity"
                      onClick={() => {
                        const instances = [...(config.connectors?.instances || [])]
                        const id = `discord-${instances.length + 1}`
                        instances.push({ id, type: "discord" })
                        updateConfig(["connectors", "instances"], instances)
                      }}
                    >
                      + Add Instance
                    </button>
                  </div>
                </div>
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
                  Add multiple connector instances of the same type, each bound to a specific employee.
                </div>
                {(config.connectors?.instances || []).map((instance: any, idx: number) => (
                  <div
                    key={instance.id || idx}
                    className="mb-[var(--space-4)] rounded-[13px] bg-[var(--fill-quaternary)] p-[var(--space-3)]"
                  >
                    <div className="flex items-center justify-between mb-[var(--space-2)]">
                      <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                        {instance.id || `Instance ${idx + 1}`}
                      </div>
                      <button
                        className="text-[var(--system-red)] hover:opacity-80 transition-opacity p-[var(--space-1)]"
                        onClick={() => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances.splice(idx, 1)
                          updateConfig(["connectors", "instances"], instances.length > 0 ? instances : undefined)
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <FieldRow label="Instance ID">
                      <SettingsInput
                        value={instance.id ?? ""}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], id: v }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        placeholder="e.g. discord-vox"
                      />
                    </FieldRow>
                    <FieldRow label="Type">
                      <SettingsSelect
                        value={instance.type ?? "discord"}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], type: v as "discord" | "slack" | "whatsapp" }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        options={[
                          { value: "discord", label: "Discord" },
                          { value: "slack", label: "Slack" },
                          { value: "whatsapp", label: "WhatsApp" },
                        ]}
                      />
                    </FieldRow>
                    <FieldRow label="Employee">
                      <SettingsSelect
                        value={instance.employee ?? ""}
                        onChange={(v) => {
                          const instances = [...(config.connectors?.instances || [])]
                          instances[idx] = { ...instances[idx], employee: v || undefined }
                          updateConfig(["connectors", "instances"], instances)
                        }}
                        options={[
                          { value: "", label: "Default (COO)" },
                          ...employees.map((e) => ({ value: e.name, label: e.displayName })),
                        ]}
                      />
                    </FieldRow>
                    {/* Type-specific fields */}
                    {(instance.type === "discord" || !instance.type) && (
                      <>
                        <FieldRow label="Bot Token">
                          <SettingsInput
                            type="password"
                            value={instance.botToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], botToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Bot token..."
                          />
                        </FieldRow>
                        <FieldRow label="Guild ID">
                          <SettingsInput
                            value={instance.guildId ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], guildId: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Server/Guild ID"
                          />
                        </FieldRow>
                        <FieldRow label="Channel ID">
                          <SettingsInput
                            value={instance.channelId ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], channelId: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Restrict to channel (optional)"
                          />
                        </FieldRow>
                        <FieldRow label="Allow From">
                          <SettingsInput
                            value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : instance.allowFrom ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], allowFrom: v.trim() ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="User IDs, comma-separated (optional)"
                          />
                        </FieldRow>
                      </>
                    )}
                    {instance.type === "slack" && (
                      <>
                        <FieldRow label="App Token">
                          <SettingsInput
                            type="password"
                            value={instance.appToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], appToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="xapp-..."
                          />
                        </FieldRow>
                        <FieldRow label="Bot Token">
                          <SettingsInput
                            type="password"
                            value={instance.botToken ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], botToken: v }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="xoxb-..."
                          />
                        </FieldRow>
                      </>
                    )}
                    {instance.type === "whatsapp" && (
                      <>
                        <FieldRow label="Auth Directory">
                          <SettingsInput
                            value={instance.authDir ?? ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], authDir: v.trim() || undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Default: ~/.jinn/.whatsapp-auth"
                          />
                        </FieldRow>
                        <FieldRow label="Allow From">
                          <SettingsInput
                            value={Array.isArray(instance.allowFrom) ? instance.allowFrom.join(", ") : ""}
                            onChange={(v) => {
                              const instances = [...(config.connectors?.instances || [])]
                              instances[idx] = { ...instances[idx], allowFrom: v.trim() ? v.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined }
                              updateConfig(["connectors", "instances"], instances)
                            }}
                            placeholder="Phone JIDs, comma-separated"
                          />
                        </FieldRow>
                      </>
                    )}
                  </div>
                ))}

                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Web UI
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
                >
                  Web conversations use queued one-shot resume flow for both engines.
                </div>
              </Section>

              {/* -- Section 6: Cron -- */}
              <Section title="Cron">
                <div
                  className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]"
                >
                  Default Delivery
                </div>
                <div
                  className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]"
                >
                  When a cron job has no delivery configured, results will be sent here.
                </div>
                <FieldRow label="Connector">
                  <SettingsSelect
                    value={config.cron?.defaultDelivery?.connector ?? ""}
                    onChange={(v) =>
                      updateConfig(["cron", "defaultDelivery", "connector"], v || undefined)
                    }
                    options={[
                      { value: "", label: "None (fire & forget)" },
                      { value: "web", label: "Web" },
                      { value: "slack", label: "Slack" },
                    ]}
                  />
                </FieldRow>
                {config.cron?.defaultDelivery?.connector && (
                  <FieldRow label="Channel">
                    <SettingsInput
                      value={config.cron?.defaultDelivery?.channel ?? ""}
                      onChange={(v) =>
                        updateConfig(["cron", "defaultDelivery", "channel"], v)
                      }
                      placeholder="#general"
                    />
                  </FieldRow>
                )}
              </Section>

              {/* -- Section 7: Logging -- */}
              <Section title="Logging">
                <FieldRow label="Level">
                  <SettingsSelect
                    value={config.logging?.level ?? "info"}
                    onChange={(v) => updateConfig(["logging", "level"], v)}
                    options={[
                      { value: "debug", label: "Debug" },
                      { value: "info", label: "Info" },
                      { value: "warn", label: "Warn" },
                      { value: "error", label: "Error" },
                    ]}
                  />
                </FieldRow>
                <FieldRow label="Stdout">
                  <ToggleSwitch
                    checked={config.logging?.stdout ?? true}
                    onChange={(v) => updateConfig(["logging", "stdout"], v)}
                  />
                </FieldRow>
                <FieldRow label="File Logging">
                  <ToggleSwitch
                    checked={config.logging?.file ?? false}
                    onChange={(v) => updateConfig(["logging", "file"], v)}
                  />
                </FieldRow>
              </Section>

              {/* -- Section 8: Voice Input (STT) -- */}
              <SttSettingsSection />

              {/* Save row for gateway config — pill buttons in the app's shared
                  grammar (accent-fill primary, quiet fill secondary). */}
              <div
                className="mb-7 flex justify-end gap-[var(--space-3)]"
              >
                <button
                  onClick={() => loadConfig()}
                  className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
                >
                  <RotateCcw size={15} />
                  Reload
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex h-[38px] items-center gap-1.5 rounded-full border-none px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98]"
                  style={{
                    background: "var(--accent-fill)",
                    color: "var(--accent)",
                    boxShadow: "var(--inset-shine)",
                    cursor: saving ? "wait" : "pointer",
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  <Save size={15} />
                  {saving ? "Saving…" : "Save Config"}
                </button>
              </div>
            </>
          )}

          {/* -- Section 7: Reset — quiet pills; destructive reads as a red wash,
                not a solid alarm block. */}
          <Section title="Reset">
            <div
              className="flex flex-wrap items-center gap-[var(--space-3)]"
            >
              <button
                onClick={() => {
                  localStorage.removeItem("jinn-onboarded")
                  window.location.reload()
                }}
                className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw size={15} />
                Re-run Onboarding
              </button>
              <button
                onClick={() => {
                  if (
                    window.confirm("Reset all settings to defaults?")
                  ) {
                    localStorage.removeItem("jinn-settings")
                    localStorage.removeItem("jinn-theme")
                    resetAll()
                    window.location.reload()
                  }
                }}
                className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none px-4 text-[length:var(--text-subheadline)] font-semibold text-[var(--system-red)] transition-transform hover:scale-[0.98]"
                style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
              >
                <Trash2 size={15} />
                Reset All Settings
              </button>
            </div>
          </Section>
        </div>
      </div>
    </PageLayout>
  )
}
