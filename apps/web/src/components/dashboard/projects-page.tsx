import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, FolderGit2, Github, Plus, Search } from "lucide-react"
import type { GitHubRepositoryDto, ProjectDto } from "@doxahq/contracts"

import {
  DashboardHeader,
  EmptyState,
  PageBody,
  Toolbar,
} from "~/components/dashboard/dashboard-header"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Skeleton } from "~/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table"
import {
  getProjectPublicationLabel,
  getProjectPublicationState,
  isProjectPublished,
} from "~/lib/dashboard/model"
import { useGitHubRepositories } from "~/lib/dashboard/use-github"
import { useProjectsSummary } from "~/lib/dashboard/use-projects-summary"

const HEAD_CLASS = "font-mono text-[11px] tracking-[0.16em] text-label uppercase"

export function ProjectsPage() {
  const summary = useProjectsSummary()
  const { projects, isError, error } = summary
  const repositoryList = useGitHubRepositories()
  const repositories = repositoryList.repositories
  // The page waits for both lists, so it shows one skeleton and then the table.
  const isPending = summary.isPending || repositoryList.isPending
  const [query, setQuery] = useState("")
  const repoNameById = useMemo(
    () => new Map(repositories.map((repo) => [repo.id, repo.fullName])),
    [repositories],
  )
  const filteredProjects = useMemo(
    () => filterProjects(projects, query),
    [projects, query],
  )
  const hasProjects = projects.length > 0

  return (
    <>
      <DashboardHeader title="Projects" />

      <PageBody>
        {isError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn’t load projects</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : hasProjects ? (
          <ProjectsList
            projects={projects}
            filteredProjects={filteredProjects}
            repoNameById={repoNameById}
            query={query}
            onQueryChange={setQuery}
          />
        ) : (
          <EmptyState
            icon={<FolderGit2 />}
            title="No projects yet"
            description="Start with example docs, or connect a GitHub repository to generate docs with AI."
            action={
              <Button asChild>
                <Link to="/dashboard/projects/new">
                  <Plus />
                  New project
                </Link>
              </Button>
            }
          />
        )}
      </PageBody>
    </>
  )
}

function ProjectsList({
  projects,
  filteredProjects,
  repoNameById,
  query,
  onQueryChange,
}: {
  projects: ProjectDto[]
  filteredProjects: ProjectDto[]
  repoNameById: Map<string, GitHubRepositoryDto["fullName"]>
  query: string
  onQueryChange: (query: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <ProjectSearch value={query} onChange={onQueryChange} />
        <Button size="sm" asChild>
          <Link to="/dashboard/projects/new">
            <Plus />
            New project
          </Link>
        </Button>
      </Toolbar>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Repositories connected for documentation generation.
        </p>
        <p className="font-mono text-[11px] tracking-[0.16em] text-label uppercase">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </p>
      </div>

      <ProjectsTable
        projects={filteredProjects}
        repoNameById={repoNameById}
        query={query}
      />
    </div>
  )
}

function ProjectSearch({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative w-full max-w-xs">
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search projects"
        className="pl-8"
      />
    </div>
  )
}

function ProjectsTable({
  projects,
  repoNameById,
  query,
}: {
  projects: ProjectDto[]
  repoNameById: Map<string, GitHubRepositoryDto["fullName"]>
  query: string
}) {
  return (
    <div className="surface-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={HEAD_CLASS}>Project</TableHead>
            <TableHead className={HEAD_CLASS}>Repository</TableHead>
            <TableHead className={HEAD_CLASS}>Status</TableHead>
            <TableHead className={HEAD_CLASS + " text-right"}>Docs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                No projects match “{query}”.
              </TableCell>
            </TableRow>
          ) : (
            projects.map((project) => (
              <ProjectTableRow
                key={project.id}
                project={project}
                repoName={project.githubRepositoryId ? repoNameById.get(project.githubRepositoryId) : undefined}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function ProjectTableRow({
  project,
  repoName,
}: {
  project: ProjectDto
  repoName: GitHubRepositoryDto["fullName"] | undefined
}) {
  const publicationState = getProjectPublicationState(project)

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <Link
            to="/dashboard/projects/$projectId"
            params={{ projectId: project.id }}
            className="font-mono text-sm text-foreground hover:text-primary-text"
          >
            {project.name}
          </Link>
          <span className="text-xs text-muted-foreground">
            /{project.slug}
            {project.team ? ` · ${project.team.name}` : null}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {repoName ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Github className="size-3.5" />
            {repoName}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={publicationState === "published" ? "success" : "muted"}>
          {getProjectPublicationLabel(publicationState)}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {isProjectPublished(project) && project.docsUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={project.docsUrl} target="_blank" rel="noopener noreferrer">
              Open
              <ArrowUpRight />
            </a>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard/projects/$projectId" params={{ projectId: project.id }}>
              Details
              <ArrowUpRight />
            </Link>
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function filterProjects(projects: ProjectDto[], query: string): ProjectDto[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return projects

  return projects.filter((project) => (
    project.name.toLowerCase().includes(normalizedQuery) ||
    project.slug.toLowerCase().includes(normalizedQuery) ||
    (project.team?.name.toLowerCase().includes(normalizedQuery) ?? false)
  ))
}
