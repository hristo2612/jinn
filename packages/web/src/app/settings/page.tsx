"use client"

import { useEffect, useState } from "react"
import { RotateCcw, Trash2, Check, Save, Loader2 } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { useSettings } from "@/app/settings-provider"
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
    }
    web?: Record<string, never>
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
    <section style={{ marginBottom: "var(--space-6)" }}>
      <div
        style={{
          fontSize: "var(--text-caption1)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
          padding: "0 var(--space-2) var(--space-2)",
        }}
      >
        {title}
      </div>
      <div
        style={{
          background: "var(--material-regular)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--separator)",
          padding: "var(--space-4)",
        }}
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
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "var(--space-2) 0",
        gap: "var(--space-4)",
      }}
    >
      <label
        style={{
          fontSize: "var(--text-subheadline)",
          color: "var(--text-secondary)",
          flexShrink: 0,
        }}
      >
        {label}
      </label>
      <div style={{ width: 240, flexShrink: 0 }}>{children}</div>
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
      className="apple-input"
      style={{
        width: "100%",
        background: "var(--bg-secondary)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-sm)",
        padding: "6px 10px",
        fontSize: "var(--text-footnote)",
        color: "var(--text-primary)",
      }}
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
      style={{
        width: "100%",
        background: "var(--bg-secondary)",
        border: "1px solid var(--separator)",
        borderRadius: "var(--radius-sm)",
        padding: "6px 10px",
        fontSize: "var(--text-footnote)",
        color: "var(--text-primary)",
        cursor: "pointer",
      }}
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
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        background: checked ? "var(--system-green)" : "var(--fill-primary)",
        border: "none",
        cursor: "pointer",
        position: "relative",
        flexShrink: 0,
        transition: "background 200ms var(--ease-smooth)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 200ms var(--ease-spring)",
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
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        marginBottom: "var(--space-4)",
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: status.available ? "var(--system-green)" : "var(--system-red)",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: "var(--text-subheadline)",
            fontWeight: "var(--weight-medium)",
            color: "var(--text-primary)",
          }}>
            {status.available
              ? `Whisper ${(status.model || "small").charAt(0).toUpperCase() + (status.model || "small").slice(1)}`
              : "No model installed"}
          </div>
          <div style={{
            fontSize: "var(--text-caption1)",
            color: "var(--text-tertiary)",
          }}>
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
          style={{
            width: "100%",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-md)",
            background: "var(--accent)",
            color: "var(--accent-contrast)",
            border: "none",
            cursor: "pointer",
            fontSize: "var(--text-footnote)",
            fontWeight: "var(--weight-semibold)",
            marginBottom: "var(--space-4)",
          }}
        >
          Download Whisper Small (~500MB)
        </button>
      )}

      {/* Download progress */}
      {status.downloading && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "var(--space-2)",
            fontSize: "var(--text-caption1)",
            color: "var(--text-tertiary)",
          }}>
            <span>Downloading model…</span>
            <span>{status.progress}%</span>
          </div>
          <div style={{
            height: 6,
            borderRadius: 3,
            background: "var(--fill-tertiary)",
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: `${status.progress}%`,
              borderRadius: 3,
              background: "var(--accent)",
              transition: "width 300ms ease",
            }} />
          </div>
        </div>
      )}

      {/* Languages section — only when model is available */}
      {status.available && (
        <>
          <div style={{
            borderTop: "1px solid var(--separator)",
            marginTop: "var(--space-2)",
            paddingTop: "var(--space-3)",
          }}>
            <div style={{
              fontSize: "var(--text-caption1)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--text-tertiary)",
              marginBottom: "var(--space-2)",
            }}>
              Transcription Languages
            </div>
            <div style={{
              fontSize: "var(--text-caption2)",
              color: "var(--text-tertiary)",
              marginBottom: "var(--space-3)",
            }}>
              First language is the default. Add multiple to show a language picker in chat.
            </div>

            {/* Language chips */}
            <div style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-2)",
              marginBottom: "var(--space-3)",
            }}>
              {status.languages.map((code) => (
                <div
                  key={code}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    padding: "3px 8px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--fill-secondary)",
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--text-primary)",
                  }}
                >
                  <span style={{
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    fontSize: "var(--text-caption2)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--accent)",
                    marginRight: 2,
                  }}>
                    {code}
                  </span>
                  {WHISPER_LANGUAGES[code] || code}
                  {status.languages.length > 1 && (
                    <button
                      onClick={() => handleRemoveLanguage(code)}
                      disabled={saving}
                      aria-label={`Remove ${WHISPER_LANGUAGES[code] || code}`}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        marginLeft: 2,
                        color: "var(--text-quaternary)",
                        fontSize: 14,
                        lineHeight: 1,
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add language */}
            <div style={{
              display: "flex",
              gap: "var(--space-2)",
            }}>
              <select
                value={addLang}
                onChange={(e) => setAddLang(e.target.value)}
                style={{
                  flex: 1,
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--separator)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 10px",
                  fontSize: "var(--text-footnote)",
                  color: addLang ? "var(--text-primary)" : "var(--text-tertiary)",
                  cursor: "pointer",
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
                style={{
                  padding: "6px 14px",
                  borderRadius: "var(--radius-sm)",
                  background: addLang ? "var(--accent)" : "var(--fill-tertiary)",
                  color: addLang ? "var(--accent-contrast)" : "var(--text-quaternary)",
                  border: "none",
                  cursor: addLang ? "pointer" : "default",
                  fontSize: "var(--text-footnote)",
                  fontWeight: "var(--weight-semibold)",
                  flexShrink: 0,
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
        className="h-full overflow-y-auto"
        style={{ background: "var(--bg)" }}
      >
        <div
          style={{
            maxWidth: 640,
            margin: "0 auto",
            padding: "var(--space-6) var(--space-4) var(--space-12)",
          }}
        >
          {/* Page header */}
          <h1
            style={{
              fontSize: "var(--text-title1)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--text-primary)",
              margin: "0 0 var(--space-6)",
            }}
          >
            Settings
          </h1>

          {/* ── Section 1: Appearance ── */}
          <Section title="Appearance">
            {/* Theme picker */}
            <div
              style={{
                fontSize: "var(--text-footnote)",
                fontWeight: "var(--weight-medium)",
                color: "var(--text-secondary)",
                marginBottom: "var(--space-2)",
              }}
            >
              Theme
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: "var(--space-2)",
                marginBottom: "var(--space-4)",
              }}
            >
              {THEMES.map((t) => {
                const isActive = theme === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      padding: "var(--space-3) var(--space-2)",
                      borderRadius: "var(--radius-md)",
                      background: "var(--fill-quaternary)",
                      border: isActive
                        ? "2px solid var(--accent)"
                        : "2px solid var(--separator)",
                      cursor: "pointer",
                      transition: "all 150ms var(--ease-smooth)",
                    }}
                  >
                    <span style={{ fontSize: 24 }}>{t.emoji}</span>
                    <span
                      style={{
                        fontSize: "var(--text-caption2)",
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
              style={{
                fontSize: "var(--text-footnote)",
                fontWeight: "var(--weight-medium)",
                color: "var(--text-secondary)",
                marginBottom: "var(--space-2)",
              }}
            >
              Accent Color
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2)",
                marginBottom: "var(--space-3)",
              }}
            >
              {ACCENT_PRESETS.map((preset) => {
                const isActive = settings.accentColor === preset.value
                return (
                  <button
                    key={preset.value}
                    onClick={() => setAccentColor(preset.value)}
                    aria-label={preset.label}
                    title={preset.label}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: preset.value,
                      border: isActive
                        ? "2px solid var(--text-primary)"
                        : "2px solid transparent",
                      outline: isActive
                        ? `2px solid ${preset.value}`
                        : "none",
                      outlineOffset: 2,
                      cursor: "pointer",
                      transition: "all 100ms var(--ease-smooth)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
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
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  fontSize: "var(--text-footnote)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                Custom:
                <input
                  type="color"
                  value={settings.accentColor ?? "#3B82F6"}
                  onChange={(e) => setAccentColor(e.target.value)}
                  style={{
                    width: 28,
                    height: 28,
                    border: "none",
                    borderRadius: "50%",
                    cursor: "pointer",
                    background: "none",
                    padding: 0,
                  }}
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
                className="apple-input"
                style={{
                  width: 90,
                  padding: "4px 8px",
                  fontSize: "var(--text-caption1)",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--separator)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  fontFamily: "monospace",
                }}
              />
              {settings.accentColor && (
                <button
                  onClick={() => setAccentColor(null)}
                  style={{
                    fontSize: "var(--text-footnote)",
                    color: "var(--system-blue)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
              )}
            </div>
          </Section>

          {/* ── Section 2: Branding ── */}
          <Section title="Branding">
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                  }}
                >
                  Portal Name
                </label>
                <input
                  type="text"
                  className="apple-input"
                  placeholder="Jinn"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={() => {
                    setPortalName(nameValue || null)
                    api.completeOnboarding({ portalName: nameValue || undefined }).catch(() => {})
                  }}
                  style={{
                    width: "100%",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-sm)",
                    padding: "6px 10px",
                    fontSize: "var(--text-footnote)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                  }}
                >
                  Portal Subtitle
                </label>
                <input
                  type="text"
                  className="apple-input"
                  placeholder="Command Centre"
                  value={subtitleValue}
                  onChange={(e) => setSubtitleValue(e.target.value)}
                  onBlur={() => setPortalSubtitle(subtitleValue || null)}
                  style={{
                    width: "100%",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-sm)",
                    padding: "6px 10px",
                    fontSize: "var(--text-footnote)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                  }}
                >
                  Operator Name
                </label>
                <input
                  type="text"
                  className="apple-input"
                  placeholder="Your Name"
                  value={operatorNameValue}
                  onChange={(e) => setOperatorNameValue(e.target.value)}
                  onBlur={() => {
                    setOperatorName(operatorNameValue || null)
                    api.completeOnboarding({ operatorName: operatorNameValue || undefined }).catch(() => {})
                  }}
                  style={{
                    width: "100%",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-sm)",
                    padding: "6px 10px",
                    fontSize: "var(--text-footnote)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                  }}
                >
                  Portal Emoji
                </label>
                <input
                  type="text"
                  className="apple-input"
                  placeholder="\ud83e\udd16"
                  value={emojiValue}
                  onChange={(e) => setEmojiValue(e.target.value)}
                  onBlur={() => setPortalEmoji(emojiValue || null)}
                  style={{
                    width: 80,
                    textAlign: "center",
                    fontSize: "var(--text-title2)",
                    padding: "6px 8px",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-sm)",
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-1)",
                  }}
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
                  style={{
                    width: "100%",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--separator)",
                    borderRadius: "var(--radius-sm)",
                    padding: "6px 10px",
                    fontSize: "var(--text-footnote)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                  }}
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
              style={{
                marginBottom: "var(--space-4)",
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background:
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(239,68,68,0.1)",
                border: `1px solid ${
                  feedback.type === "success"
                    ? "rgba(34,197,94,0.3)"
                    : "rgba(239,68,68,0.3)"
                }`,
                fontSize: "var(--text-footnote)",
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
              style={{
                textAlign: "center",
                padding: "var(--space-8)",
                color: "var(--text-tertiary)",
                fontSize: "var(--text-footnote)",
              }}
            >
              <Loader2
                size={20}
                style={{ animation: "spin 1s linear infinite", margin: "0 auto var(--space-2)" }}
              />
              Loading gateway config...
            </div>
          ) : configError ? (
            <div
              style={{
                marginBottom: "var(--space-6)",
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                fontSize: "var(--text-footnote)",
                color: "var(--system-red)",
              }}
            >
              Failed to load config: {configError}
            </div>
          ) : (
            <>
              {/* ── Section 3: Gateway Configuration ── */}
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

              {/* ── Section 4: Engine Configuration ── */}
              <Section title="Engine Configuration">
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
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
                  style={{
                    borderTop: "1px solid var(--separator)",
                    marginTop: "var(--space-3)",
                    paddingTop: "var(--space-3)",
                  }}
                />

                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
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

              {/* ── Section 5: Connectors ── */}
              <Section title="Connectors">
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
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
                  style={{
                    borderTop: "1px solid var(--separator)",
                    marginTop: "var(--space-3)",
                    paddingTop: "var(--space-3)",
                  }}
                />

                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
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

                <div
                  style={{
                    borderTop: "1px solid var(--separator)",
                    marginTop: "var(--space-3)",
                    paddingTop: "var(--space-3)",
                  }}
                />

                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  Web UI
                </div>
                <div
                  style={{
                    fontSize: "var(--text-caption2)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  Web conversations use queued one-shot resume flow for both engines.
                </div>
              </Section>

              {/* ── Section 6: Cron ── */}
              <Section title="Cron">
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  Default Delivery
                </div>
                <div
                  style={{
                    fontSize: "var(--text-caption2)",
                    color: "var(--text-tertiary)",
                    marginBottom: "var(--space-3)",
                  }}
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

              {/* ── Section 7: Logging ── */}
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

              {/* ── Section 8: Voice Input (STT) ── */}
              <SttSettingsSection />

              {/* Save button for gateway config */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "var(--space-3)",
                  marginBottom: "var(--space-6)",
                }}
              >
                <button
                  onClick={() => loadConfig()}
                  style={{
                    padding: "var(--space-2) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--fill-tertiary)",
                    color: "var(--text-secondary)",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "var(--text-footnote)",
                    fontWeight: "var(--weight-medium)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <RotateCcw size={14} />
                  Reload
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    padding: "var(--space-2) var(--space-5)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--accent)",
                    color: "var(--accent-contrast)",
                    border: "none",
                    cursor: saving ? "wait" : "pointer",
                    fontSize: "var(--text-footnote)",
                    fontWeight: "var(--weight-semibold)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    opacity: saving ? 0.7 : 1,
                    transition: "all 150ms var(--ease-smooth)",
                  }}
                >
                  <Save size={14} />
                  {saving ? "Saving..." : "Save Config"}
                </button>
              </div>
            </>
          )}

          {/* ── Section 7: Reset ── */}
          <Section title="Reset">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-3)",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => {
                  localStorage.removeItem("jinn-onboarded")
                  window.location.reload()
                }}
                style={{
                  padding: "var(--space-2) var(--space-5)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--accent)",
                  color: "var(--accent-contrast)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-footnote)",
                  fontWeight: "var(--weight-semibold)",
                  transition: "all 150ms var(--ease-spring)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
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
                style={{
                  padding: "var(--space-2) var(--space-5)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--system-red)",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-footnote)",
                  fontWeight: "var(--weight-semibold)",
                  transition: "all 150ms var(--ease-spring)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
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
