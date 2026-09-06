// ---------------------------------------------------------------------------
// Section wrapper using CSS variable styling
// ---------------------------------------------------------------------------

export function Section({
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
export const CONTROL_CLASS =
  "min-h-[40px] md:min-h-0 w-full rounded-[10px] border-none bg-[var(--fill-tertiary)] px-[12px] py-[7px] " +
  "text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none " +
  "placeholder:text-[var(--text-tertiary)] transition-[box-shadow] duration-150 " +
  "focus:shadow-[0_0_0_3px_var(--accent-fill)]"

export function FieldRow({
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

export function SettingsInput({
  value,
  onChange,
  type = "text",
  placeholder,
  disabled = false,
  min,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
  min?: number
  ariaLabel?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      aria-label={ariaLabel}
      className={`${CONTROL_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
    />
  )
}

export function SettingsSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  ariaLabel?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={`${CONTROL_CLASS} cursor-pointer`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="relative h-[40px] md:h-[34px] w-[44px] shrink-0 cursor-pointer rounded-[17px] border-none bg-transparent"
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-[24px] -translate-y-1/2 rounded-[12px] transition-[background] duration-200 ease-[var(--ease-smooth)]"
        style={{
          background: checked ? "var(--system-green)" : "var(--fill-primary)",
        }}
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 h-[20px] w-[20px] -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200 ease-[var(--ease-spring)]"
        style={{
          left: checked ? 22 : 2,
        }}
      />
    </button>
  )
}
