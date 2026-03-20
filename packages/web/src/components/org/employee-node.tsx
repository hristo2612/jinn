"use client"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"

type EmployeeNodeData = Employee & Record<string, unknown>

export function EmployeeNode({ data, selected }: NodeProps) {
  const employee = data as EmployeeNodeData

  return (
    <div
      className="bg-[var(--material-regular)] backdrop-blur-[20px] backdrop-saturate-[180%] [-webkit-backdrop-filter:blur(20px)_saturate(180%)] rounded-[var(--radius-md,12px)] py-[var(--space-3)] px-[var(--space-4)] w-[220px] cursor-pointer relative transition-shadow duration-150 ease-in-out"
      style={{
        border: `1px solid ${selected ? "var(--accent)" : "var(--separator)"}`,
        boxShadow: selected
          ? "0 0 0 1px var(--accent), var(--shadow-card)"
          : "var(--shadow-card)",
      }}
    >
      {/* Avatar + Name row */}
      <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-1)]">
        <EmployeeAvatar name={employee.name} size={24} />
        <div className="flex-1 min-w-0">
          <div className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis leading-[var(--leading-tight)]">
            {employee.displayName || employee.name}
          </div>
          <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis mt-px">
            {employee.department}
          </div>
        </div>
      </div>

      {/* Engine badge */}
      <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)]">
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] bg-[var(--accent-fill)] py-px px-[7px] rounded-[10px]">
          {employee.engine}
        </span>
      </div>

      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

export function DepartmentGroupNode({ data }: NodeProps) {
  const { label } = data as { label: string } & Record<string, unknown>
  return (
    <div className="w-full h-full relative">
      <div className="absolute top-[14px] left-[16px] text-[11px] font-[600] tracking-[0.06em] uppercase text-[var(--text-tertiary)] select-none opacity-60 pointer-events-none">
        {label}
      </div>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />
    </div>
  )
}

export const nodeTypes = {
  employeeNode: EmployeeNode,
  departmentGroup: DepartmentGroupNode,
}
