import { useState } from "react"
import { AlertCircle, Github, Link2, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { RepositoryOption } from "~/components/dashboard/repository-option"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Skeleton } from "~/components/ui/skeleton"
import { writePendingRepositoryConnect } from "~/lib/dashboard/pending-repository-connect"
import { useGitHub } from "~/lib/dashboard/use-github"
import { useConnectProjectRepository } from "~/lib/dashboard/use-project-repository"

/**
 * Picks a GitHub repository for a project that has none. Without the GitHub
 * App, it sends the user to install it and returns here afterwards.
 *
 * The dialog content mounts only while the dialog is open, so a page that
 * offers the dialog loads the repository list only when the user opens it.
 */
export function ConnectRepositoryDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const connection = useConnectProjectRepository(projectId)

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && connection.isConnecting) return
    if (!nextOpen) connection.reset()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="overscroll-contain shadow-none">
        <ConnectRepositoryForm
          projectId={projectId}
          connection={connection}
          onConnected={() => handleOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ConnectRepositoryForm({
  projectId,
  connection,
  onConnected,
}: {
  projectId: string
  connection: ReturnType<typeof useConnectProjectRepository>
  onConnected: () => void
}) {
  const github = useGitHub()
  const [selectedId, setSelectedId] = useState("")
  const projectForRepository = (repositoryId: string) => {
    const project = github.projectByRepositoryId.get(repositoryId) ?? null
    return project && project.id !== projectId ? project : null
  }
  const selectedProject = selectedId ? projectForRepository(selectedId) : null

  async function handleConnect() {
    if (!selectedId || selectedProject) return
    try {
      const project = await connection.connectRepository(selectedId)
      toast.success(project.repositoryFullName ? `Connected ${project.repositoryFullName}` : "Repository connected")
      onConnected()
    } catch {
      // The mutation error renders in the dialog.
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-balance">Connect a repository</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <DialogDescription className="text-pretty">
          Doxa reads the repository to generate docs with AI. The first generation replaces the example pages.
        </DialogDescription>

        {github.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : github.isConnected ? (
          <div className="flex max-h-72 flex-col overflow-y-auto rounded-lg border border-border">
            {github.repositories.map((repo, index) => (
              <RepositoryOption
                key={repo.id}
                repo={repo}
                existingProject={projectForRepository(repo.id)}
                hasDivider={index > 0}
                isSelected={repo.id === selectedId}
                onSelect={() => setSelectedId(repo.id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Install the Doxa GitHub App to choose which repositories Doxa can read. You return here after the
            install.
          </p>
        )}

        {selectedProject ? (
          <Alert>
            <AlertDescription>
              This repository already belongs to the project “{selectedProject.name}”. Choose another repository.
            </AlertDescription>
          </Alert>
        ) : null}

        {github.repositoriesError || connection.error ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="break-words">
              {connection.error ?? github.repositoriesError}
            </AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {github.isConnected ? (
          <>
            <Button variant="ghost" size="sm" asChild>
              <a href={github.githubInstallUrl} onClick={() => writePendingRepositoryConnect(projectId)}>
                <Link2 aria-hidden="true" />
                Manage GitHub access
              </a>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!selectedId || Boolean(selectedProject) || connection.isConnecting}
              onClick={() => void handleConnect()}
            >
              {connection.isConnecting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              {connection.isConnecting ? "Connecting…" : "Connect repository"}
            </Button>
          </>
        ) : (
          <Button size="sm" asChild>
            <a href={github.githubInstallUrl} onClick={() => writePendingRepositoryConnect(projectId)}>
              <Github aria-hidden="true" />
              Install GitHub App
            </a>
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
