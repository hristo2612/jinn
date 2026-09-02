import type { WorkflowDefinitionWire } from "@/lib/api"
/**
 * The values a workflow declares it needs before a manual run can start.
 *
 * Returns null when the operator backs out -- a cancelled prompt, or a required
 * field left blank -- so the caller starts nothing. An empty map means the
 * definition declares no inputs, which is the common case and still a run.
 */
export function collectRunInput(inputs: WorkflowDefinitionWire["inputs"]): Record<string, string> | null {
  const values: Record<string, string> = {}
  for (const input of inputs ?? []) {
    const value = window.prompt(
      `${input.label}${input.description ? `\n\n${input.description}` : ""}`,
      typeof input.default === "string" ? input.default : "",
    )
    if (value === null) return null
    if (input.required && !value.trim()) {
      window.alert(`${input.label} is required.`)
      return null
    }
    if (value.trim()) values[input.key] = value.trim()
  }
  return values
}
