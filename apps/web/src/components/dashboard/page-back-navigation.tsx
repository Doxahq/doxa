import type { ReactElement } from "react"
import { Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"

import { Button } from "~/components/ui/button"

export function PageBackNavigation({ children }: { children: ReactElement }) {
  return (
    <nav aria-label="Back navigation" className="self-start">
      <Button variant="ghost" size="sm" asChild>
        {children}
      </Button>
    </nav>
  )
}

export function ProjectsBackNavigation() {
  return (
    <PageBackNavigation>
      <Link to="/dashboard/projects">
        <ArrowLeft aria-hidden="true" />
        Projects
      </Link>
    </PageBackNavigation>
  )
}

export function GenerationsBackNavigation({ projectId }: { projectId: string }) {
  return (
    <PageBackNavigation>
      <Link
        to="/dashboard/projects/$projectId/generations"
        params={{ projectId }}
      >
        <ArrowLeft aria-hidden="true" />
        Generations
      </Link>
    </PageBackNavigation>
  )
}
