import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { roleHasCapability, type Capability, type TeamRole } from "@doxahq/contracts/teams"

import { projectDetailQueryOptions } from "~/lib/queries/dashboard"

/** What the viewer may do on a project, read from the shared role table. */
export interface ProjectCapabilities {
  /** The viewer's role; null until the project loads. */
  readonly role: TeamRole | null
  /** False while the role is unknown, so a write control never flashes for a viewer. */
  readonly can: (capability: Capability) => boolean
}

export function projectCapabilities(role: TeamRole | null): ProjectCapabilities {
  return {
    role,
    can: (capability) => role !== null && roleHasCapability(role, capability),
  }
}

/** The capabilities of the viewer's role on the project (spec §5). The API enforces them too. */
export function useProjectCapabilities(projectId: string): ProjectCapabilities {
  const role = useQuery({ ...projectDetailQueryOptions(projectId), select: (detail) => detail.role }).data ?? null
  return useMemo(() => projectCapabilities(role), [role])
}

/** Why a control is unavailable, for a tooltip or a note beside it. */
export const ROLE_RESTRICTED_MESSAGE = "Your role in this project does not allow this."
