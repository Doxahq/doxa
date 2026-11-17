import { useEffect, useMemo, useState } from "react"
import type { GitHubRepositoryDto } from "@doxahq/contracts"
import { AlertCircle, Check, Github, Link2, Search, Sparkles } from "lucide-react"

import { InstructionsOfferContent } from "~/components/dashboard/instructions-offer-dialog"
import { RepositoryProductionBranchField } from "~/components/dashboard/new-project/repository-production-branch-field"
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
import { Input } from "~/components/ui/input"
import { Skeleton } from "~/components/ui/skeleton"
import { useGenerateFromRepository } from "~/lib/dashboard/use-generate-from-repository"
import { cn } from "~/lib/utils"

const STEPS = ["Connect GitHub", "Choose a repository", "Generate"] as const

/**
 * Connect GitHub, choose a repository, answer the instructions offer, and
 * start the first Doxabot generation. Without the GitHub App, it sends the user to install it; GitHub
 * returns to `/dashboard?github=connected`, which opens this dialog again.
 *
 * The content mounts only while the dialog is open, so the repository list
 * loads only when the user opens it. `teamId` owns the new project (null:
 * personal).
 */
export function GenerateFromRepositoryDialog({
  open,
  teamId,
  onOpenChange,
  onStartWithoutRepository,
}: {
  open: boolean
  teamId: string | null
  onOpenChange: (open: boolean) => void
  onStartWithoutRepository: () => void
}) {
  // The dialog stays open while the project is created and the generation
  // starts, so the user sees the result.
  const [isBusy, setIsBusy] = useState(false)

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && isBusy) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Wide, and as tall as the window allows: the header and footer stay put while the body scrolls. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-4xl flex-col overscroll-contain shadow-none">
        <GenerateFromRepositoryForm
          teamId={teamId}
          onBusyChange={setIsBusy}
          onClose={() => handleOpenChange(false)}
          onStartWithoutRepository={onStartWithoutRepository}
        />
      </DialogContent>
    </Dialog>
  )
}

function GenerateFromRepositoryForm({
  teamId,
  onBusyChange,
  onClose,
  onStartWithoutRepository,
}: {
  teamId: string | null
  onBusyChange: (busy: boolean) => void
  onClose: () => void
  onStartWithoutRepository: () => void
}) {
  const { github, addInstructions, generate, pendingChoice } = useGenerateFromRepository(teamId)
  const isGenerating = pendingChoice !== null
  useEffect(() => onBusyChange(isGenerating), [isGenerating, onBusyChange])
  const [selectedId, setSelectedId] = useState("")
  // Null follows the selected repository's default branch until the person picks another.
  const [chosenBranch, setChosenBranch] = useState<string | null>(null)
  // No project exists yet at this step, so going back leaves nothing behind.
  const [offer, setOffer] = useState<{ repository: GitHubRepositoryDto; productionBranch: string } | null>(null)
  const [query, setQuery] = useState("")
  const repositories = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized
      ? github.repositories.filter((repo) => repo.fullName.toLowerCase().includes(normalized))
      : github.repositories
  }, [github.repositories, query])
  const selected = github.repositories.find((repo) => repo.id === selectedId) ?? null
  const selectedProject = selectedId ? github.projectByRepositoryId.get(selectedId) ?? null : null
  const productionBranch = chosenBranch ?? selected?.defaultBranch ?? ""
  const currentStep = github.isConnected ? 1 : 0

  function selectRepository(repositoryId: string) {
    setSelectedId(repositoryId)
    if (repositoryId !== selectedId) setChosenBranch(null)
  }

  if (offer) {
    return (
      <InstructionsOfferContent
        isStep
        pendingChoice={pendingChoice}
        error={github.createError}
        onCancel={() => setOffer(null)}
        onAddInstructions={() => void addInstructions(offer.repository, offer.productionBranch)}
        onGenerateWithout={() => void generate(offer.repository, offer.productionBranch)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-balance">Generate docs from a repository</DialogTitle>
        <DialogDescription className="text-pretty">
          Doxabot reads your code and writes the first version of your docs. You review it before it goes live.
        </DialogDescription>
        <StepList current={github.isLoading ? -1 : currentStep} />
      </DialogHeader>

      <DialogBody className="min-h-0 space-y-4 overflow-y-auto scrollbar-subtle">
        {github.isLoading ? (
          <RepositoryListSkeleton />
        ) : github.isConnected ? (
          <>
            <div className="relative">
              <Search aria-hidden="true" className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search repositories"
                aria-label="Search repositories"
                autoComplete="off"
                className="pl-8"
              />
            </div>
            <div
              role="group"
              aria-label="Repository"
              className="flex max-h-[min(30rem,45dvh)] flex-col overflow-y-auto rounded-lg border border-border scrollbar-subtle"
            >
              {repositories.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">No repository matches “{query}”.</p>
              ) : (
                repositories.map((repo, index) => (
                  <RepositoryOption
                    key={repo.id}
                    repo={repo}
                    existingProject={github.projectByRepositoryId.get(repo.id) ?? null}
                    hasDivider={index > 0}
                    isSelected={repo.id === selectedId}
                    onSelect={() => selectRepository(repo.id)}
                  />
                ))
              )}
            </div>
            {selected && !selectedProject ? (
              <RepositoryProductionBranchField
                githubRepositoryId={selected.id}
                value={productionBranch}
                onValueChange={setChosenBranch}
                disabled={isGenerating}
              />
            ) : null}
            <p className="flex items-start gap-2 text-[13px] leading-5 text-muted-foreground">
              <Sparkles aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary-text" />
              <span>
                {selected ? (
                  <>
                    Doxabot creates the project <span className="font-mono text-body">{selected.name}</span>. You can
                    add instructions before it starts writing.
                  </>
                ) : (
                  "Choose a repository. Doxabot creates a project for it and writes your docs."
                )}
              </span>
            </p>
          </>
        ) : (
          <ConnectGitHubPanel installUrl={github.githubInstallUrl} />
        )}

        {selectedProject ? (
          <Alert>
            <AlertDescription>
              This repository already belongs to the project “{selectedProject.name}”. Choose another repository.
            </AlertDescription>
          </Alert>
        ) : null}

        {github.repositoriesError || github.createError ? (
          <Alert variant="destructive" aria-live="polite">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="break-words">{github.createError ?? github.repositoriesError}</AlertDescription>
          </Alert>
        ) : null}
      </DialogBody>

      <DialogFooter>
        {github.isConnected ? (
          <Button variant="ghost" size="sm" className="sm:mr-auto" asChild>
            <a href={github.githubInstallUrl}>
              <Link2 aria-hidden="true" />
              Repository not listed? Manage GitHub access
            </a>
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="sm:mr-auto" onClick={onStartWithoutRepository}>
            Start without a repository
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={isGenerating} onClick={onClose}>
          Cancel
        </Button>
        {github.isConnected ? (
          <Button
            type="button"
            size="sm"
            disabled={!selected || Boolean(selectedProject) || isGenerating || !productionBranch}
            onClick={() => {
              if (selected) setOffer({ repository: selected, productionBranch })
            }}
          >
            <Sparkles aria-hidden="true" />
            Generate docs
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}

/** Connect GitHub → Choose a repository → Generate, with the current step lit. */
function StepList({ current }: { current: number }) {
  return (
    <ol aria-label="Steps" className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {STEPS.map((label, index) => {
        const done = index < current
        const active = index === current
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase",
              active || done ? "text-foreground" : "text-label",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[10px] tracking-normal",
                active && "border-primary bg-primary-wash",
                done && "border-success/50 bg-success/8 text-success",
                !active && !done && "border-border-strong",
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            {label}
            {index < STEPS.length - 1 ? <span aria-hidden="true" className="h-px w-6 bg-border" /> : null}
          </li>
        )
      })}
    </ol>
  )
}

function ConnectGitHubPanel({ installUrl }: { installUrl: string }) {
  return (
    <div className="flex flex-col items-center gap-3.5 rounded-lg border border-border bg-sidebar px-6 py-8 text-center">
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-full border border-border bg-surface-hover text-foreground"
      >
        <Github className="size-5" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-mono text-[13px] font-bold tracking-[0.12em] text-foreground uppercase">Connect GitHub</h3>
        <p className="max-w-sm text-[13px] leading-5 text-muted-foreground">
          Install the Doxa GitHub App. You choose which repositories Doxa can see, and you can change that at any time.
          You return here after the install.
        </p>
      </div>
      <Button asChild>
        <a href={installUrl}>
          <Github aria-hidden="true" />
          Connect GitHub
        </a>
      </Button>
    </div>
  )
}

/** The search box and list rows, in the place they appear. */
function RepositoryListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <Skeleton className="h-9 w-full" />
      <div className="flex flex-col rounded-lg border border-border">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className={cn("flex items-center gap-2.5 px-4 py-3.5", row > 0 && "border-t border-border")}>
            <Skeleton className="size-4" />
            <Skeleton className="h-4 w-48" />
          </div>
        ))}
      </div>
    </div>
  )
}
