import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { GitHubRepositoryDto } from "@doxahq/contracts"
import { toast } from "sonner"

import { writeLastProjectId } from "~/lib/dashboard/last-project"
import { useGitHub } from "~/lib/dashboard/use-github"
import { getErrorMessage } from "~/lib/errors"
import { startGeneration } from "~/lib/platform-api"

/**
 * Creates a project for a GitHub repository and starts the first Doxabot
 * generation, then opens the generation page. When the project exists but the
 * generation does not start, it opens the project overview, which offers the
 * start again.
 */
export function useGenerateFromRepository() {
  const github = useGitHub()
  const navigate = useNavigate()
  const start = useMutation({ mutationFn: (projectId: string) => startGeneration(projectId) })
  // Stays on until the next page opens, so the button does not come back
  // between the two requests and the navigation.
  const [isGenerating, setIsGenerating] = useState(false)

  async function generate(repository: GitHubRepositoryDto): Promise<void> {
    setIsGenerating(true)
    let projectId: string
    try {
      const project = await github.createProject({ githubRepositoryId: repository.id, name: repository.name })
      projectId = project.id
    } catch {
      // The create error renders in the dialog.
      setIsGenerating(false)
      return
    }
    writeLastProjectId(projectId)

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
    generate,
    isGenerating,
  }
}
