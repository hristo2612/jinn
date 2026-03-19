"use client"

import { useEffect, useState } from "react"
import { RotateCcw, Trash2, Check, Save, Loader2 } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/app/settings-provider"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { useTheme } from "@/app/providers"
import { THEMES } from "@/lib/themes"
import type { ThemeId } from "@/lib/themes"
import { api } from "@/lib/api"

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
  }
  sessions?: {
    maxDurationMinutes?: number
    maxCostUsd?: number
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
    whatsapp?: {
      authDir?: string
      allowFrom?: string[]
    }
    web?: Record<string, never>
    instances?: Array<{
      id: string
      type: "discord" | "slack" | "whatsapp"
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
  cron?: {
    defaultDelivery?: { connector?: string; channel?: string }
  }
  portal?: {
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
    <section className="mb-[var(--space-6)]">
      <div
        className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)] px-[var(--space-2)] pb-[var(--space-2)]"
      >
        {title}
      </div>
      <div
        className="bg-[var(--material-regular)] rounded-[var(--radius-md)] border border-[var(--separator)] p-[var(--space-4)]"
      >
        {children}
      </div>
    </section>
  )
}

function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between py-[var(--space-2)] gap-[var(--space-4)]"
    >
      <label
        className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0"
      >
        {label}
      </label>
      <div className="w-[240px] shrink-0">{children}</div>
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
      className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
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
      className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
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
                className="flex-1 bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] cursor-pointer"
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
    setPortalName,
    setPortalSubtitle,
    setOperatorName,
    setPortalEmoji,
    setLanguage,
    resetAll,
  } = useSettings()
  const { theme, setTheme } = useTheme()

  // Local branding inputs
  const [nameValue, setNameValue] = useState(settings.portalName ?? "")
  const [subtitleValue, setSubtitleValue] = useState(settings.portalSubtitle ?? "")
  const [operatorNameValue, setOperatorNameValue] = useState(settings.operatorName ?? "")
  const [emojiValue, setEmojiValue] = useState(settings.portalEmoji ?? "")
  const [languageValue, setLanguageValue] = useState(settings.language ?? "English")
  const [customHex, setCustomHex] = useState(settings.accentColor ?? "")

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
        setEmployees(org.employees.map((e: any) => ({ name: e.name, displayName: e.displayName || e.name })))
      }
    }).catch(() => {})
  }, [])

  // Sync local values when settings change externally (e.g., reset)
  useEffect(() => {
    setNameValue(settings.portalName ?? "")
    setSubtitleValue(settings.portalSubtitle ?? "")
    setOperatorNameValue(settings.operatorName ?? "")
    setEmojiValue(settings.portalEmoji ?? "")
    setLanguageValue(settings.language ?? "English")
    setCustomHex(settings.accentColor ?? "")
  }, [
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
      <div
        className="h-full overflow-y-auto bg-[var(--bg)]"
      >
        <div
          className="max-w-[640px] mx-auto px-[var(--space-4)] py-[var(--space-6)] pb-[var(--space-12)]"
        >
          {/* Page header */}
          <h1
            className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-6)]"
          >
            Settings
          </h1>

          {/* -- Section 1: Appearance -- */}
          <Section title="Appearance">
            {/* Theme picker */}
            <div
              className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]"
            >
              Theme
            </div>
            <div
              className="grid grid-cols-5 gap-[var(--space-2)] mb-[var(--space-4)]"
            >
              {THEMES.map((t) => {
                const isActive = theme === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="flex flex-col items-center gap-[var(--space-1)] px-[var(--space-2)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] cursor-pointer transition-all duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      border: isActive
                        ? "2px solid var(--accent)"
                        : "2px solid var(--separator)",
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
                    title={preset.label}
                    className="w-[32px] h-[32px] rounded-full cursor-pointer transition-all duration-100 ease-[var(--ease-smooth)] flex items-center justify-center"
                    style={{
                      background: preset.value,
                      border: isActive
                        ? "2px solid var(--text-primary)"
                        : "2px solid transparent",
                      outline: isActive
                        ? `2px solid ${preset.value}`
                        : "none",
                      outlineOffset: 2,
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
                className="apple-input w-[90px] px-[8px] py-[4px] text-[length:var(--text-caption1)] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] text-[var(--text-primary)] font-mono"
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
                  Portal Name
                </label>
                <input
                  type="text"
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
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
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
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
                  className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
                  placeholder="Your Name"
                  value={operatorNameValue}
                  onChange={(e) => setOperatorNameValue(e.target.value)}
                  onBlur={() => {
                    setOperatorName(operatorNameValue || null)
                    api.completeOnboarding({ operatorName: operatorNameValue || undefined }).catch(() => {})
                  }}
                />
              </div>

              <div>
                <label
                  className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
                >
                  Portal Emoji
                </label>
                <input
                  type="text"
                  className="apple-input w-[80px] text-center text-[length:var(--text-title2)] px-[8px] py-[6px] bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)]"
                  placeholder="\ud83e\udd16"
                  value={emojiValue}
                  onChange={(e) => setEmojiValue(e.target.value)}
                  onBlur={() => setPortalEmoji(emojiValue || null)}
                />
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
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)] cursor-pointer"
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

          {/* Gateway config feedback */}
          {feedback && (
            <div
              className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)]"
              style={{
                background:
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(239,68,68,0.1)",
                border: `1px solid ${
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.3)"
                    : "rgba(239,68,68,0.3)"
                }`,
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
              className="mb-[var(--space-6)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
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
                    options={[
                      { value: "opus", label: "Opus (claude-opus-4-6)" },
                      { value: "sonnet", label: "Sonnet (claude-sonnet-4-6)" },
                      { value: "haiku", label: "Haiku (claude-haiku-4-5)" },
                    ]}
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.claude?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "effortLevel"], v)
                    }
                    options={[
                      { value: "default", label: "Default" },
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                    ]}
                  />
                </FieldRow>

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
                    value={config.engines?.codex?.model ?? "gpt-5.4"}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "model"], v)
                    }
                    options={[
                      { value: "gpt-5.4", label: "GPT-5.4" },
                      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
                      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
                      { value: "gpt-5.2", label: "GPT-5.2" },
                      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
                      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
                    ]}
                  />
                </FieldRow>
                <FieldRow label="Effort Level">
                  <SettingsSelect
                    value={config.engines?.codex?.effortLevel ?? "default"}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "effortLevel"], v)
                    }
                    options={[
                      { value: "default", label: "Default" },
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                      { value: "xhigh", label: "Extra High" },
                    ]}
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
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
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
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
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
                      className="w-[200px] h-[200px] rounded-[var(--radius-md)] border border-[var(--separator)] bg-white p-[8px]"
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
                <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
                  Add multiple connector instances of the same type, each bound to a specific employee.
                </div>
                {(config.connectors?.instances || []).map((instance: any, idx: number) => (
                  <div
                    key={instance.id || idx}
                    className="mb-[var(--space-4)] p-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg-secondary)]"
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

              {/* Save button for gateway config */}
              <div
                className="flex justify-end gap-[var(--space-3)] mb-[var(--space-6)]"
              >
                <button
                  onClick={() => loadConfig()}
                  className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-medium)] inline-flex items-center gap-[6px]"
                >
                  <RotateCcw size={14} />
                  Reload
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] inline-flex items-center gap-[6px] transition-all duration-150 ease-[var(--ease-smooth)]"
                  style={{
                    cursor: saving ? "wait" : "pointer",
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  <Save size={14} />
                  {saving ? "Saving..." : "Save Config"}
                </button>
              </div>
            </>
          )}

          {/* -- Section 7: Reset -- */}
          <Section title="Reset">
            <div
              className="flex items-center justify-center gap-[var(--space-3)] flex-wrap"
            >
              <button
                onClick={() => {
                  localStorage.removeItem("jinn-onboarded")
                  window.location.reload()
                }}
                className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
              >
                <RotateCcw size={14} />
                Re-run Onboarding Wizard
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
                className="px-[var(--space-5)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--system-red)] text-white border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-all duration-150 ease-[var(--ease-spring)] inline-flex items-center gap-[var(--space-2)]"
              >
                <Trash2 size={14} />
                Reset All Settings
              </button>
            </div>
          </Section>
        </div>
      </div>
    </PageLayout>
  )
}
