import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import {
  Bar,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"

export const DOXABOT_PAGE_DESCRIPTION =
  "Doxabot reads your repository and writes your docs. Choose how it writes, when it runs, and what it reuses between runs."

export const INSTRUCTIONS_PAGE_DESCRIPTION =
  "Tell Doxabot who reads your docs and how they should sound. Doxabot follows these preferences when it writes. They cannot change what Doxabot can read or where your docs are published."

/** The cards of the Doxabot page, with their real titles. */
const DOXABOT_CARDS = [
  { title: "Instructions", action: "5.5rem" },
  { title: "Pull request previews", action: null },
  { title: "Generation cache", action: null },
] as const

/** The Doxabot page until every card's data is there. */
export function ProjectDoxabotSkeleton() {
  return (
    <PageBodySkeleton label="Loading Doxabot" className="max-w-4xl">
      <PageHeadingSkeleton label="Project" title="Doxabot" description={DOXABOT_PAGE_DESCRIPTION} />
      <div className="flex gap-2">
        <Bar width="8.5rem" height="2.25rem" className="rounded-md" />
        <Bar width="8rem" height="2.25rem" className="rounded-md" />
      </div>
      <section className="flex flex-col gap-4">
        <div className="surface-card grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {["Repository", "Last generation", "Instructions", "PR previews"].map((label) => (
            <div key={label} className="flex flex-col gap-1.5 px-5 py-4">
              <span className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">{label}</span>
              <TextBar width="7rem" className="text-sm" />
              <TextBar width="9rem" className="text-[12.5px]" />
            </div>
          ))}
        </div>
        {DOXABOT_CARDS.map((card) => (
          <Card key={card.title}>
            <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Bar width="1.25rem" height="1.25rem" className="mt-0.5" />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <CardTitle>
                    <h3>{card.title}</h3>
                  </CardTitle>
                  <CardDescription>
                    <TextBar width="22rem" className="text-sm leading-6" />
                  </CardDescription>
                </div>
              </div>
              {card.action ? <Bar width={card.action} height="2.25rem" className="rounded-md" /> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Bar width="16rem" height="1.75rem" className="rounded-md" />
            </CardContent>
          </Card>
        ))}
      </section>
    </PageBodySkeleton>
  )
}

/** The instructions editor: back link, heading, the form sections and the side column. */
export function DoxabotInstructionsSkeleton() {
  return (
    <PageBodySkeleton label="Loading instructions" className="max-w-6xl">
      <TextBar width="4.5rem" className="text-sm" />
      <PageHeadingSkeleton label="Doxabot" title="Instructions" description={INSTRUCTIONS_PAGE_DESCRIPTION} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {["11rem", "9rem", "8rem", "7rem", "9.5rem", "10rem"].map((width, index) => (
            <section key={index} className="surface-card flex flex-col gap-4 px-5 py-5">
              <TextBar width={width} className="font-mono text-xs" />
              <Bar width="100%" height="2.25rem" className="rounded-md" />
            </section>
          ))}
        </div>
        <aside className="flex w-full flex-col gap-4 lg:w-80">
          {["8rem", "10rem", "6rem"].map((width, index) => (
            <section key={index} className="surface-card flex flex-col gap-3 px-5 py-5">
              <TextBar width={width} className="font-mono text-xs" />
              <Bar width="100%" height="6rem" className="rounded-md" />
            </section>
          ))}
        </aside>
      </div>
    </PageBodySkeleton>
  )
}
