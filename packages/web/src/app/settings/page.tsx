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
    codex?: { bin?: string; model?: string }
  }
  connectors?: {
    slack?: { appToken?: string; botToken?: string }
    web?: { bidirectional?: boolean; idleTimeoutMinutes?: number; hardTimeoutHours?: number }
  }
  logging?: {
    level?: string
    stdout?: boolean
    file?: boolean
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
    resetAll,
  } = useSettings()
  const { theme, setTheme } = useTheme()

  // Local branding inputs
  const [nameValue, setNameValue] = useState(settings.portalName ?? "")
  const [subtitleValue, setSubtitleValue] = useState(settings.portalSubtitle ?? "")
  const [operatorNameValue, setOperatorNameValue] = useState(settings.operatorName ?? "")
  const [emojiValue, setEmojiValue] = useState(settings.portalEmoji ?? "")
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
    setCustomHex(settings.accentColor ?? "")
  }, [
    settings.portalName,
    settings.portalSubtitle,
    settings.operatorName,
    settings.portalEmoji,
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
                  placeholder="Jimmy"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={() => setPortalName(nameValue || null)}
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
                  onBlur={() => setOperatorName(operatorNameValue || null)}
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
                  <SettingsInput
                    value={config.engines?.claude?.model ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "claude", "model"], v)
                    }
                    placeholder="claude-sonnet-4-20250514"
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
                  <SettingsInput
                    value={config.engines?.codex?.model ?? ""}
                    onChange={(v) =>
                      updateConfig(["engines", "codex", "model"], v)
                    }
                    placeholder="codex-mini-latest"
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
                <FieldRow label="Bidirectional Mode">
                  <ToggleSwitch
                    checked={config.connectors?.web?.bidirectional !== false}
                    onChange={(v) =>
                      updateConfig(["connectors", "web", "bidirectional"], v)
                    }
                  />
                </FieldRow>
                {config.connectors?.web?.bidirectional !== false && (
                  <>
                    <FieldRow label="Idle Timeout (min)">
                      <SettingsInput
                        type="number"
                        value={String(config.connectors?.web?.idleTimeoutMinutes ?? 60)}
                        onChange={(v) =>
                          updateConfig(["connectors", "web", "idleTimeoutMinutes"], Number(v) || 0)
                        }
                        placeholder="60"
                      />
                    </FieldRow>
                    <FieldRow label="Hard Timeout (hrs)">
                      <SettingsInput
                        type="number"
                        value={String(config.connectors?.web?.hardTimeoutHours ?? 24)}
                        onChange={(v) =>
                          updateConfig(["connectors", "web", "hardTimeoutHours"], Number(v) || 0)
                        }
                        placeholder="24"
                      />
                    </FieldRow>
                  </>
                )}
              </Section>

              {/* ── Section 6: Logging ── */}
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
                  localStorage.removeItem("jimmy-onboarded")
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
                    localStorage.removeItem("jimmy-settings")
                    localStorage.removeItem("jimmy-theme")
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
