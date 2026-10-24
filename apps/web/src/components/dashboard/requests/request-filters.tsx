import type { ReactNode } from "react"

import { Select } from "~/components/dashboard/content/site-settings/fields/controls"
import {
  REQUEST_STATUS_FILTER_OPTIONS,
  type RequestAgentFilter,
  type RequestFilterOption,
  type RequestStatusFilter,
} from "~/lib/dashboard/approval-request-filters"

/** The status and agent filters above the request list. */
export function RequestFilters({
  status,
  onStatusChange,
  agent,
  agentOptions,
  onAgentChange,
}: {
  status: RequestStatusFilter
  onStatusChange: (status: RequestStatusFilter) => void
  agent: RequestAgentFilter
  agentOptions: readonly RequestFilterOption<RequestAgentFilter>[]
  onAgentChange: (agent: RequestAgentFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterField label="Status">
        <Select
          aria-label="Filter by status"
          value={status}
          options={REQUEST_STATUS_FILTER_OPTIONS}
          onValueChange={onStatusChange}
          className="w-44"
        />
      </FilterField>
      <FilterField label="Agent">
        <Select
          aria-label="Filter by agent"
          value={agent}
          options={agentOptions}
          onValueChange={onAgentChange}
          className="w-52"
        />
      </FilterField>
    </div>
  )
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}
