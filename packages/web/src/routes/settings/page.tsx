
import { useEffect, useRef, useState } from "react"
import { RotateCcw, Trash2, Check, Loader2, Plus, EyeOff } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { useSettings } from "@/routes/settings-provider"
import { api } from "@/lib/api"
import { authFetch } from "@/lib/auth"
import { useModelRegistry } from "@/hooks/use-model-registry"
import { useOnboarding } from "@/hooks/use-onboarding"
import { cn } from "@/lib/utils"
import { resolveTodoIdPrefix } from "@/lib/todo-id"
import {
  addModelOverride,
  hideModelOverride,
  resetEngineModelOverrides,
  showModelOverride,
} from "@/lib/model-config"
import { ACCENT_PRESETS, ThemePicker, TextSizePicker } from "./appearance-pickers"
import { OperatorEmojiRow, PortalEmojiRow } from "./emoji-rows"
import { ConfigConflictNotice } from "./config-conflict-notice"
import { ConfigSaveStatus } from "./config-save-status"
import { PluginsEntry } from "./plugins/entry"
import { EnginesSection } from "./engines/entry"
import type { Config } from "./config-shape"
import { configSaveBlocker } from "./engines/model-map-model"
import { SttSettingsSection } from "./stt-section"
import { VoiceSection } from "./voice-section"
import { PairingSection } from "./pairing-section"
import { ShortcutsSection } from "./shortcuts-section"
import { useConfigCommit } from "./use-config-commit"
import { useVoiceCapability } from "./use-voice-capability"
import {
  CONTROL_CLASS,
  FieldRow,
  Section,
  SettingsInput,
  SettingsSelect,
  ToggleSwitch,
} from "./shared"



// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const {
    settings,
    setAccentColor,
    setCompanyName,
    setPortalName,
    setPortalSubtitle,
    setOperatorName,
    setLanguage,
    setTalkOrb,
    resetAll,
  } = useSettings()

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
  const [languageValue, setLanguageValue] = useState(settings.language ?? "English")
  const [customHex, setCustomHex] = useState(settings.accentColor ?? "")
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
  /** The document the next write is built from. Held beside the state because two
   *  edits in one tick both have to reach the writer, not just the last render. */
  const configRef = useRef<Config>({})
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ message: string; remedy?: string } | null>(null)
  const { voiceCapability, reloadVoiceCapability } = useVoiceCapability()
  const { saveState, commit, adoptRevision } = useConfigCommit({
    blocker: (next) => configSaveBlocker(next.engines, modelRegistry?.engines),
    onSaved: reloadVoiceCapability,
    onConflict: setConflict,
  })

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
    setLanguageValue(settings.language ?? "English")
    setCustomHex(settings.accentColor ?? "")
  }, [
    settings.companyName,
    settings.portalName,
    settings.portalSubtitle,
    settings.operatorName,
    settings.language,
    settings.accentColor,
  ])

  // Load gateway config
  function loadConfig() {
    setConfigLoading(true)
    api
      .getConfig()
      .then(({ config: loaded, revision }) => {
        configRef.current = loaded as Config
        setConfig(loaded as Config)
        adoptRevision(revision)
        // Reloading is the way out of a conflict, so it is also what clears it.
        setConflict(null)
        setCompanyPrefixValue((loaded as Config).portal?.companyPrefix ?? "")
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
        const statusRes = await authFetch("/api/status")
        const status = await statusRes.json()
        const connStatus = status?.connectors?.whatsapp?.status
        if (!cancelled) setWaStatus(connStatus ?? "unknown")

        if (connStatus === "qr_pending") {
          const qrRes = await authFetch("/api/connectors/whatsapp/qr")
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

  /** Editing and saving are one action now that there is no Save button. */
  function applyModelConfig(updater: (cfg: Config) => Config) {
    const next = updater(configRef.current)
    configRef.current = next
    setConfig(next)
    commit(next)
  }

  function updateConfig(path: string[], value: unknown) {
    applyModelConfig((prev) => {
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

  const claudeRegistryModels = modelRegistry?.engines?.claude?.models ?? []
  const hiddenClaudeIds = config.models?.claude?.hidden ?? []
  const registryClaudeIds = new Set(claudeRegistryModels.map((m) => m.id))
  const customClaudeModels = (config.models?.claude?.models ?? []).filter((m) => !registryClaudeIds.has(m.id))
  const claudeEffortDefaults = Array.from(new Set(claudeRegistryModels.flatMap((m) => m.effortLevels)))
  const visibleClaudeModels = claudeRegistryModels.filter((m) => !hiddenClaudeIds.includes(m.id))
  const hiddenClaudeModels = hiddenClaudeIds.map((id) => claudeRegistryModels.find((m) => m.id === id) ?? { id, label: id })
  const staleChatEnabled = config.sessions?.staleChat?.enabled ?? true

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

  return (
    <PageLayout>
      {/* Forms read best narrow, so the column is 640px. */}
      <PageScaffold contentWidth="640px" header={<LargeTitleHeader title="Settings" subtitle="Portal, gateway and connectors" />}>
        <div>
          {/* -- Section 1: Appearance -- */}
          <Section title="Appearance">
            <ThemePicker />
            <TextSizePicker />

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
                    className="flex h-[40px] w-[40px] md:h-[30px] md:w-[30px] cursor-pointer items-center justify-center rounded-full border-none transition-transform duration-100 ease-[var(--ease-smooth)] hover:scale-105"
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
                  className="w-[40px] h-[40px] md:w-[28px] md:h-[28px] border-none rounded-full cursor-pointer bg-transparent p-0"
                />
              </label>
              <input
                type="text"
                aria-label="Custom accent hex color"
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

            <div className="mt-[var(--space-4)]">
              <FieldRow label="Talk Orb">
                <div className="flex sm:justify-end">
                  <ToggleSwitch
                    checked={settings.talkOrb}
                    ariaLabel="Talk orb"
                    onChange={setTalkOrb}
                  />
                </div>
              </FieldRow>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                A floating voice control you can drag to any corner. It shows what the
                assistant is doing through motion alone.
              </div>
              {/* Said here rather than on the first press, which is where the
                  operator used to find out. */}
              {settings.talkOrb && voiceCapability?.configured === false && (
                <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                  Voice is not set up yet, so the orb cannot open a session. Pick a
                  provider in the Voice section below.
                </div>
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

              <OperatorEmojiRow />

              <PortalEmojiRow />

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

          <PairingSection />

          <ShortcutsSection />

          {conflict && (
            <ConfigConflictNotice
              message={conflict.message}
              remedy={conflict.remedy}
              onReload={() => loadConfig()}
            />
          )}

          <ConfigSaveStatus state={saveState} />

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
                    options={Object.values(modelRegistry?.engines ?? {}).map((e) => ({ value: e.name, label: e.name.charAt(0).toUpperCase() + e.name.slice(1), disabled: !e.available }))}
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
                      className="inline-flex items-center justify-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border-none bg-[var(--accent)] px-[10px] py-[6px] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] disabled:cursor-default disabled:opacity-50" // jinn-shell: ok inline settings control, not page chrome
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

              {/* -- Section 4b: Engine Fallbacks — health and fallback chains -- */}
              <EnginesSection
                engines={config.engines}
                sessions={config.sessions}
                onChange={updateConfig}
              />

              {/* -- Section 5: Sessions -- */}
              <Section title="Sessions">
                <FieldRow label="Suggest Fresh Chats">
                  <ToggleSwitch
                    checked={staleChatEnabled}
                    ariaLabel="Suggest fresh chats"
                    onChange={(v) =>
                      updateConfig(["sessions", "staleChat", "enabled"], v)
                    }
                  />
                </FieldRow>
                <FieldRow label="Context Token Threshold">
                  <SettingsInput
                    type="number"
                    min={1000}
                    ariaLabel="Context token threshold"
                    disabled={!staleChatEnabled}
                    value={String(config.sessions?.staleChat?.tokenThreshold ?? 300_000)}
                    onChange={(v) =>
                      updateConfig(["sessions", "staleChat", "tokenThreshold"], Number(v))
                    }
                  />
                </FieldRow>
                <FieldRow label="Idle Minutes">
                  <SettingsInput
                    type="number"
                    min={1}
                    ariaLabel="Idle minutes"
                    disabled={!staleChatEnabled}
                    value={String(config.sessions?.staleChat?.staleAfterMinutes ?? 60)}
                    onChange={(v) =>
                      updateConfig(["sessions", "staleChat", "staleAfterMinutes"], Number(v))
                    }
                  />
                </FieldRow>
                <div className="mt-[4px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  Suggest a clean continuation when a chat is both over the context threshold and idle past the selected window.
                </div>

                <div
                  className="mt-[var(--space-3)] border-t border-[var(--separator)] pt-[var(--space-3)]"
                />

                <FieldRow label="Interrupt on New Message">
                  <ToggleSwitch
                    checked={config.sessions?.interruptOnNewMessage ?? true}
                    ariaLabel="Interrupt on new message"
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

              {/* -- Section 8: Voice (realtime, speech-to-speech) -- */}
              <VoiceSection
                provider={config.realtime?.provider ?? ""}
                apiKey={config.realtime?.apiKey ?? ""}
                model={config.realtime?.model ?? ""}
                voice={config.realtime?.voice ?? ""}
                turnDetection={config.realtime?.turnDetection}
                noiseReduction={config.realtime?.noiseReduction ?? ""}
                capability={voiceCapability}
                onChange={updateConfig}
                talkOrbOn={settings.talkOrb}
              />

              {/* -- Section 9: Voice Input (STT) -- */}
              <SttSettingsSection />

              {/* Edits save themselves; reloading is how the operator throws one
                  away or picks up a hand edit. Quiet fill, in the shared grammar. */}
              <div
                className="mb-7 flex justify-end"
              >
                <button
                  onClick={() => loadConfig()}
                  className="inline-flex h-[38px] cursor-pointer items-center gap-1.5 rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
                >
                  <RotateCcw size={15} />
                  Reload
                </button>
              </div>
            </>
          )}

          <PluginsEntry />
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
      </PageScaffold>
    </PageLayout>
  )
}
