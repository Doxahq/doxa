import { useNavigate } from "@tanstack/react-router"
import { Github, Link2, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"

import {
  DashboardHeader,
  EmptyState,
  PageBody,
  SectionDescription,
  SectionLabel,
} from "~/components/dashboard/dashboard-header"
import { ExampleProjectOption } from "~/components/dashboard/example-project-option"
import { RepositoryOption } from "~/components/dashboard/repository-option"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Skeleton } from "~/components/ui/skeleton"
import { useGitHub, type GitHubConnection } from "~/lib/dashboard/use-github"
import { useCreateExampleProject } from "~/lib/dashboard/use-project-repository"

export function NewProjectPage() {
  const navigate = useNavigate()
  const github = useGitHub()
  const example = useCreateExampleProject()

  async function handleCreateExample(name: string) {
    try {
      const project = await example.createExampleProject({ name })
      toast.success(`Project “${project.name}” created`)
      await navigate({ to: "/dashboard/projects/$projectId/project", params: { projectId: project.id } })
    } catch {
      // The mutation error renders in the example option.
    }
  }

  async function handleCreate() {
    if (!github.selectedRepository) return
    if (github.selectedRepositoryProject) {
      toast.error(getExistingProjectMessage(github.selectedRepository.fullName, github.selectedRepositoryProject.name))
      return
    }

    try {
      const project = await github.createProject({
        githubRepositoryId: github.selectedRepository.id,
        name: github.selectedRepository.name,
      })
      toast.success(`Project “${project.name}” created`)
      await navigate({ to: "/dashboard/projects" })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project")
    }
  }

  return (
    <>
      <DashboardHeader title="New project" />

      <PageBody>
        <ExampleProjectOption
          isCreating={example.isCreating}
          error={example.error}
          onCreate={handleCreateExample}
        />
        <OptionDivider label="Or generate docs from a GitHub repository" />
        <NewProjectContent github={github} onCreateProject={handleCreate} />
      </PageBody>
    </>
  )
}

function NewProjectContent({
  github,
  onCreateProject,
}: {
  github: GitHubConnection
  onCreateProject: () => Promise<void>
}) {
  return (
    <>
      {github.repositoriesError ? (
        <Alert variant="destructive">
          <AlertDescription>{github.repositoriesError}</AlertDescription>
        </Alert>
      ) : null}

      {github.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : github.isConnected ? (
        <RepositorySelection github={github} onCreateProject={onCreateProject} />
      ) : (
        <ConnectGitHubEmptyState github={github} />
      )}
    </>
  )
}

function RepositorySelection({
  github,
  onCreateProject,
}: {
  github: GitHubConnection
  onCreateProject: () => Promise<void>
}) {
  const selectedRepositoryProject = github.selectedRepositoryProject
  const createDisabled = !github.selectedRepository || github.isCreatingProject || Boolean(selectedRepositoryProject)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Choose a repository</SectionLabel>
        <SectionDescription>
          Doxa clones the repo and generates hosted docs from it.
        </SectionDescription>
      </div>

      <div className="flex max-h-[440px] flex-col overflow-y-auto rounded-lg border border-border">
        {github.repositories.map((repo, index) => (
          <RepositoryOption
            key={repo.id}
            repo={repo}
            existingProject={github.projectByRepositoryId.get(repo.id) ?? null}
            hasDivider={index > 0}
            isSelected={repo.id === github.selectedRepositoryId}
            onSelect={() => github.setSelectedRepositoryId(repo.id)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <a
          href={github.githubInstallUrl}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Link2 className="size-3.5" />
          Manage GitHub access
        </a>
        <Button
          onClick={onCreateProject}
          disabled={createDisabled}
        >
          {github.isCreatingProject ? <Loader2 className="animate-spin" /> : <Plus />}
          {selectedRepositoryProject ? "Project exists" : "Create project"}
        </Button>
      </div>

      {selectedRepositoryProject && github.selectedRepository ? (
        <Alert>
          <AlertTitle>Project already exists</AlertTitle>
          <AlertDescription>
            {getExistingProjectMessage(github.selectedRepository.fullName, selectedRepositoryProject.name)} Open it from
            the Projects page instead.
          </AlertDescription>
        </Alert>
      ) : null}

      {github.createError ? (
        <Alert variant="destructive">
          <AlertDescription>{github.createError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function OptionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function getExistingProjectMessage(repositoryName: string, projectName: string): string {
  return `A project already exists for ${repositoryName}: ${projectName}.`
}

function ConnectGitHubEmptyState({ github }: { github: GitHubConnection }) {
  return (
    <EmptyState
      icon={<Github />}
      title="Connect GitHub"
      description="Install the Doxa GitHub App to choose which repositories to document."
      action={
        <div className="flex flex-col items-center gap-2">
          <Button asChild>
            <a href={github.githubInstallUrl}>
              <Github />
              Connect GitHub App
            </a>
          </Button>
          {github.showLocalInstallCallback ? (
            <Button variant="outline" size="sm" asChild>
              <a href={github.localInstallCallbackUrl}>Local install callback</a>
            </Button>
          ) : null}
        </div>
      }
    />
  )
}
