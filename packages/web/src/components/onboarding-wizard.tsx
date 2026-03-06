"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
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
import { useSettings } from "@/app/settings-provider"
import { useTheme } from "@/app/providers"
import { THEMES } from "@/lib/themes"

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
  } = useSettings()
  const { theme, setTheme } = useTheme()
  const router = useRouter()

  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  // Local input values
  const [localName, setLocalName] = useState("")
  const [localOperator, setLocalOperator] = useState("")

  const TOTAL_STEPS = 4

  // First-run detection
  useEffect(() => {
    if (forceOpen) {
      setLocalName(settings.portalName ?? "")
      setLocalOperator(settings.operatorName ?? "")
      setVisible(true)
      return
    }
    if (
      typeof window !== "undefined" &&
      !localStorage.getItem("jimmy-onboarded")
    ) {
      setVisible(true)
    }
  }, [forceOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = useCallback(() => {
    // Commit name/operator on step 0
    if (step === 0) {
      setPortalName(localName || null)
      setOperatorName(localOperator || null)
    }

    if (step < TOTAL_STEPS - 1) {
      setDirection("forward")
      setStep(step + 1)
    } else {
      // Complete
      if (!forceOpen) {
        localStorage.setItem("jimmy-onboarded", "true")
      }
      setVisible(false)
      onClose?.()
      router.push("/chat")
    }
  }, [
    step,
    localName,
    localOperator,
    forceOpen,
    onClose,
    setPortalName,
    setOperatorName,
    router,
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
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <div
        className="animate-fade-in"
        style={{
          width: "100%",
          maxWidth: 520,
          margin: "0 var(--space-4)",
          background: "var(--material-regular)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--separator)",
          boxShadow: "0 24px 48px rgba(0,0,0,0.3)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
        }}
      >
        {/* Step indicator dots */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            padding: "var(--space-4) var(--space-4) 0",
          }}
        >
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              style={{
                width: i === step ? 24 : 8,
                height: 8,
                borderRadius: 4,
                background:
                  i === step
                    ? "var(--accent)"
                    : i < step
                      ? "var(--accent)"
                      : "var(--fill-tertiary)",
                opacity: i < step ? 0.5 : 1,
                transition: "all 200ms var(--ease-smooth)",
              }}
            />
          ))}
        </div>

        {/* Step content */}
        <div
          style={{
            padding: "var(--space-5) var(--space-5) var(--space-4)",
            overflowY: "auto",
            flex: 1,
          }}
        >
          {/* Step 0: Welcome */}
          {step === 0 && (
            <div
              key="step-0"
              className="animate-fade-in"
              style={{ textAlign: "center" }}
            >
              <div
                style={{
                  fontSize: 56,
                  marginBottom: "var(--space-3)",
                  lineHeight: 1,
                }}
              >
                {"\ud83e\udd16"}
              </div>
              <h2
                style={{
                  fontSize: "var(--text-large-title)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Welcome to Jimmy
              </h2>
              <p
                style={{
                  fontSize: "var(--text-body)",
                  color: "var(--text-secondary)",
                  lineHeight: "var(--leading-relaxed)",
                  maxWidth: 400,
                  margin: "0 auto var(--space-5)",
                }}
              >
                Your AI team management portal. Let&apos;s get you set up.
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                  textAlign: "left",
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
                    value={localName}
                    onChange={(e) => setLocalName(e.target.value)}
                    autoFocus
                    style={{
                      width: "100%",
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--separator)",
                      borderRadius: "var(--radius-sm)",
                      padding: "8px 12px",
                      fontSize: "var(--text-body)",
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
                    What should we call you?
                  </label>
                  <input
                    type="text"
                    className="apple-input"
                    placeholder="Your Name"
                    value={localOperator}
                    onChange={(e) => setLocalOperator(e.target.value)}
                    style={{
                      width: "100%",
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--separator)",
                      borderRadius: "var(--radius-sm)",
                      padding: "8px 12px",
                      fontSize: "var(--text-body)",
                      color: "var(--text-primary)",
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Theme */}
          {step === 1 && (
            <div key="step-1" className="animate-fade-in">
              <h2
                style={{
                  fontSize: "var(--text-title1)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                Choose your theme
              </h2>
              <p
                style={{
                  fontSize: "var(--text-subheadline)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-4)",
                }}
              >
                Pick the look that suits you. This applies live.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                  gap: "var(--space-3)",
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
                        gap: "var(--space-2)",
                        padding: "var(--space-4) var(--space-3)",
                        borderRadius: "var(--radius-md)",
                        background: "var(--fill-quaternary)",
                        border: isActive
                          ? "2px solid var(--accent)"
                          : "2px solid var(--separator)",
                        cursor: "pointer",
                        transition: "all 150ms var(--ease-smooth)",
                      }}
                    >
                      <span style={{ fontSize: 28 }}>{t.emoji}</span>
                      <span
                        style={{
                          fontSize: "var(--text-footnote)",
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
              <h2
                style={{
                  fontSize: "var(--text-title1)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                Pick an accent color
              </h2>
              <p
                style={{
                  fontSize: "var(--text-subheadline)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-4)",
                }}
              >
                Personalize with your favorite color.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: "var(--space-3)",
                  justifyItems: "center",
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
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        background: preset.value,
                        border: "none",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        outline: isActive
                          ? `3px solid ${preset.value}`
                          : "none",
                        outlineOffset: 3,
                        transition: "all 100ms var(--ease-smooth)",
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
              <h2
                style={{
                  fontSize: "var(--text-title1)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                You&apos;re all set!
              </h2>
              <p
                style={{
                  fontSize: "var(--text-subheadline)",
                  color: "var(--text-tertiary)",
                  marginBottom: "var(--space-4)",
                }}
              >
                Here&apos;s what you can do.
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                {FEATURES.map((f) => {
                  const Icon = f.icon
                  return (
                    <div
                      key={f.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-3)",
                        padding: "var(--space-3)",
                        borderRadius: "var(--radius-md)",
                        background: "var(--fill-quaternary)",
                        border: "1px solid var(--separator)",
                      }}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 8,
                          background: "var(--accent-fill)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Icon
                          size={18}
                          style={{ color: "var(--accent)" }}
                        />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "var(--text-subheadline)",
                            fontWeight: "var(--weight-semibold)",
                            color: "var(--text-primary)",
                          }}
                        >
                          {f.name}
                        </div>
                        <div
                          style={{
                            fontSize: "var(--text-caption1)",
                            color: "var(--text-tertiary)",
                          }}
                        >
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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "var(--space-3) var(--space-5) var(--space-5)",
            gap: "var(--space-3)",
          }}
        >
          {step > 0 ? (
            <button
              onClick={handleBack}
              style={{
                padding: "var(--space-2) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--fill-tertiary)",
                color: "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                fontSize: "var(--text-subheadline)",
                fontWeight: "var(--weight-medium)",
                transition: "all 150ms var(--ease-smooth)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <ArrowLeft size={16} />
              Back
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleNext}
            style={{
              padding: "var(--space-2) var(--space-6)",
              borderRadius: "var(--radius-md)",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              border: "none",
              cursor: "pointer",
              fontSize: "var(--text-subheadline)",
              fontWeight: "var(--weight-semibold)",
              transition: "all 150ms var(--ease-smooth)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
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
