import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { GitHubRepositoryDto } from "@doxahq/contracts"
import { toast } from "sonner"

import type { InstructionsOfferChoice } from "~/components/dashboard/instructions-offer-dialog"
import { writeLastProjectId } from "~/lib/dashboard/last-project"
import { useGitHub } from "~/lib/dashboard/use-github"
import { getErrorMessage } from "~/lib/errors"
import { startGeneration } from "~/lib/platform-api"

/**
 * Creates a project for a GitHub repository, as the person chose: open the
 * instructions page first, or start the first Doxabot generation at once. When
 * the project exists but the generation does not start, it opens the project
 * overview, which offers the start again.
 */
export function useGenerateFromRepository() {
  const github = useGitHub()
  const navigate = useNavigate()
  const start = useMutation({ mutationFn: (projectId: string) => startGeneration(projectId) })
  // Stays set until the next page opens, so the buttons do not come back
  // between the requests and the navigation.
  const [pendingChoice, setPendingChoice] = useState<InstructionsOfferChoice | null>(null)

  /** Null when the create failed. The error renders in the dialog. */
  async function createProject(repository: GitHubRepositoryDto): Promise<string | null> {
    try {
      const project = await github.createProject({ githubRepositoryId: repository.id, name: repository.name })
      writeLastProjectId(project.id)
      return project.id
    } catch {
      setPendingChoice(null)
      return null
    }
  }

  async function addInstructions(repository: GitHubRepositoryDto): Promise<void> {
    setPendingChoice("instructions")
    const projectId = await createProject(repository)
    if (projectId === null) return
    await navigate({
      to: "/dashboard/projects/$projectId/doxabot/instructions",
      params: { projectId },
      search: { then: "generate" },
    })
  }

  async function generate(repository: GitHubRepositoryDto): Promise<void> {
    setPendingChoice("generation")
    const projectId = await createProject(repository)
    if (projectId === null) return

    try {
      const result = await start.mutateAsync(projectId)
      if (result.job) {
        await navigate({
          to: "/dashboard/projects/$projectId/generations/$generationId",
          params: { projectId, generationId: result.job.id },
        })
        return
      }
      toast.info(result.message)
    } catch (error) {
      toast.error(
        getErrorMessage(error, "The project was created, but the generation did not start. Start it from the project."),
      )
    }
    await navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId } })
  }

  return {
    github,
    addInstructions,
    generate,
    pendingChoice,
  }
}
