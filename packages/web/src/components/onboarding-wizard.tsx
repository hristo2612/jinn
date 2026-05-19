
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  MessageSquare,
  Users,
  Columns3,
  Clock,
  DollarSign,
  Activity,
  Check,
  ArrowLeft,
  ArrowRight,
  Rocket,
} from "lucide-react"
import { useSettings } from "@/routes/settings-provider"
import { useTheme } from "@/routes/providers"
import { THEMES } from "@/lib/themes"
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
// Feature cards for overview step
// ---------------------------------------------------------------------------

const FEATURES = [
  { icon: MessageSquare, name: "Chat", desc: "Direct conversations with any employee" },
  { icon: Users, name: "Organization", desc: "Visual org chart of your AI team" },
  { icon: Columns3, name: "Kanban", desc: "Task boards for work management" },
  { icon: Clock, name: "Cron", desc: "Scheduled jobs with status monitoring" },
  { icon: DollarSign, name: "Costs", desc: "Token usage and cost tracking" },
  { icon: Activity, name: "Activity", desc: "Real-time logs and event stream" },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface OnboardingWizardProps {
  forceOpen?: boolean
  onClose?: () => void
}

export function OnboardingWizard({ forceOpen, onClose }: OnboardingWizardProps) {
  const {
    settings,
    setPortalName,
    setOperatorName,
    setAccentColor,
    setLanguage,
  } = useSettings()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()

  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  // Local input values
  const [localName, setLocalName] = useState("")
  const [localOperator, setLocalOperator] = useState("")
  const [localLanguage, setLocalLanguage] = useState(settings.language ?? "English")

  const TOTAL_STEPS = 4

  // First-run detection — check server-side flag, not just localStorage
  useEffect(() => {
    if (forceOpen) {
      setLocalName(settings.portalName ?? "")
      setLocalOperator(settings.operatorName ?? "")
      setVisible(true)
      return
    }
    // If localStorage says onboarded, trust it (fast path)
    if (typeof window !== "undefined" && localStorage.getItem("jinn-onboarded")) {
      return
    }
    // Otherwise check server — the onboarded flag persists across browsers
    api.getOnboarding().then((data) => {
      if (data.onboarded) {
        localStorage.setItem("jinn-onboarded", "true")
      } else if (data.needed) {
        setVisible(true)
      }
    }).catch(() => {
      // Fallback: show wizard if we can't reach the server and no localStorage flag
      if (!localStorage.getItem("jinn-onboarded")) {
        setVisible(true)
      }
    })
  }, [forceOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = useCallback(() => {
    // Commit name/operator/language on step 0
    if (step === 0) {
      setPortalName(localName || null)
      setOperatorName(localOperator || null)
      setLanguage(localLanguage || "English")
    }

    if (step < TOTAL_STEPS - 1) {
      setDirection("forward")
      setStep(step + 1)
    } else {
      // Complete — persist to backend config
      api.completeOnboarding({
        portalName: localName || undefined,
        operatorName: localOperator || undefined,
        language: localLanguage || undefined,
      }).catch(() => {
        // Best-effort: localStorage still has the values
      })
      if (!forceOpen) {
        localStorage.setItem("jinn-onboarded", "true")
      }
      setVisible(false)
      onClose?.()
      navigate("/")
    }
  }, [
    step,
    localName,
    localOperator,
    forceOpen,
    onClose,
    setPortalName,
    setOperatorName,
    navigate,
  ])

  const handleBack = useCallback(() => {
    if (step > 0) {
      setDirection("back")
      setStep(step - 1)
    }
  }, [step])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      style={{
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <div
        className="animate-fade-in w-full max-w-[520px] mx-[var(--space-4)] bg-[var(--material-regular)] rounded-[var(--radius-lg)] border border-[var(--separator)] overflow-hidden flex flex-col max-h-[90vh]"
        style={{
          boxShadow: "0 24px 48px rgba(0,0,0,0.3)",
        }}
      >
        {/* Step indicator dots */}
        <div className="flex justify-center gap-2 pt-[var(--space-4)] px-[var(--space-4)]">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className="h-2 rounded-full transition-all duration-200"
              style={{
                width: i === step ? 24 : 8,
                background:
                  i === step
                    ? "var(--accent)"
                    : i < step
                      ? "var(--accent)"
                      : "var(--fill-tertiary)",
                opacity: i < step ? 0.5 : 1,
              }}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="px-[var(--space-5)] pt-[var(--space-5)] pb-[var(--space-4)] overflow-y-auto flex-1">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <div
              key="step-0"
              className="animate-fade-in text-center"
            >
              <div className="text-[56px] mb-[var(--space-3)] leading-none">
                {"\ud83e\udd16"}
              </div>
              <h2 className="text-[length:var(--text-large-title)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-2)]">
                Welcome to {localName || "Jinn"}
              </h2>
              <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)] max-w-[400px] mx-auto mb-[var(--space-5)]">
                Your AI team management portal. Let&apos;s get you set up.
              </p>

              <div className="flex flex-col gap-[var(--space-3)] text-left">
                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    Portal Name
                  </label>
                  <input
                    type="text"
                    className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"
                    placeholder="Jinn"
                    value={localName}
                    onChange={(e) => setLocalName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    What should we call you?
                  </label>
                  <input
                    type="text"
                    className="apple-input w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)]"
                    placeholder="Your Name"
                    value={localOperator}
                    onChange={(e) => setLocalOperator(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    Preferred Language
                  </label>
                  <select
                    value={localLanguage}
                    onChange={(e) => setLocalLanguage(e.target.value)}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--separator)] rounded-[var(--radius-sm)] px-3 py-2 text-[length:var(--text-body)] text-[var(--text-primary)] cursor-pointer"
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
            </div>
          )}

          {/* Step 1: Theme */}
          {step === 1 && (
            <div key="step-1" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                Choose your theme
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Pick the look that suits you. This applies live.
              </p>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-[var(--space-3)]">
                {THEMES.map((t) => {
                  const isActive = theme === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      className="flex flex-col items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-4)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] cursor-pointer transition-all duration-150"
                      style={{
                        border: isActive
                          ? "2px solid var(--accent)"
                          : "2px solid var(--separator)",
                      }}
                    >
                      <span className="text-[28px]">{t.emoji}</span>
                      <span
                        className="text-[length:var(--text-footnote)]"
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
            </div>
          )}

          {/* Step 2: Accent Color */}
          {step === 2 && (
            <div key="step-2" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                Pick an accent color
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Personalize with your favorite color.
              </p>

              <div className="grid grid-cols-6 gap-[var(--space-3)] justify-items-center">
                {ACCENT_PRESETS.map((preset) => {
                  const isActive = settings.accentColor === preset.value
                  return (
                    <button
                      key={preset.value}
                      onClick={() => setAccentColor(preset.value)}
                      aria-label={preset.label}
                      title={preset.label}
                      className="w-10 h-10 rounded-full border-none cursor-pointer flex items-center justify-center transition-all duration-100"
                      style={{
                        background: preset.value,
                        outline: isActive
                          ? `3px solid ${preset.value}`
                          : "none",
                        outlineOffset: 3,
                      }}
                    >
                      {isActive && (
                        <Check size={18} color="#fff" strokeWidth={3} />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Step 3: Overview */}
          {step === 3 && (
            <div key="step-3" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                You&apos;re all set!
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Here&apos;s what you can do.
              </p>

              <div className="flex flex-col gap-[var(--space-2)]">
                {FEATURES.map((f) => {
                  const Icon = f.icon
                  return (
                    <div
                      key={f.name}
                      className="flex items-center gap-[var(--space-3)] p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)]"
                    >
                      <div className="w-9 h-9 rounded-lg bg-[var(--accent-fill)] flex items-center justify-center shrink-0">
                        <Icon
                          size={18}
                          className="text-[var(--accent)]"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                          {f.name}
                        </div>
                        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                          {f.desc}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between items-center px-[var(--space-5)] pb-[var(--space-5)] pt-[var(--space-3)] gap-[var(--space-3)]">
          {step > 0 ? (
            <button
              onClick={handleBack}
              className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-medium)] transition-all duration-150 inline-flex items-center gap-1.5"
            >
              <ArrowLeft size={16} />
              Back
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleNext}
            className="px-[var(--space-6)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] transition-all duration-150 inline-flex items-center gap-1.5"
          >
            {step === 0
              ? "Next"
              : step === TOTAL_STEPS - 1
                ? "Get Started"
                : "Next"}
            {step === TOTAL_STEPS - 1 ? (
              <Rocket size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
