import { createContext, useContext, type ReactNode } from "react"

import { useBranchContext } from "~/lib/dashboard/use-branch-context"
import { useRenderedPathname } from "~/lib/dashboard/use-rendered-pathname"

export type ProjectBranchState = ReturnType<typeof useBranchContext>

const ProjectBranchContext = createContext<ProjectBranchState | null>(null)

/**
 * One branch selection per project for the whole dashboard shell.
 *
 * The selection lives in React state, so two callers of `useBranchContext`
 * would drift apart. The sidebar, the top bar, the status bar and the editor
 * all read this single instance instead. Site settings opened from outside
 * the content editor use `main`, because only the editor shows the branch.
 */
export function ProjectBranchProvider({
  projectId,
  children,
}: {
  projectId: string
  children: ReactNode
}) {
  const pathname = useRenderedPathname()
  const branch = useBranchContext(projectId, pathname)
  return <ProjectBranchContext.Provider value={branch}>{children}</ProjectBranchContext.Provider>
}

export function useProjectBranch(): ProjectBranchState {
  const branch = useContext(ProjectBranchContext)
  if (!branch) throw new Error("useProjectBranch must be used within ProjectBranchProvider")
  return branch
}

/** The branch state, or null outside a project. */
export function useOptionalProjectBranch(): ProjectBranchState | null {
  return useContext(ProjectBranchContext)
}
