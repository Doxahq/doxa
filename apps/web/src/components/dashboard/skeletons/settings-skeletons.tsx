import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import {
  Bar,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"

/** The cards of project Settings, with their real titles and descriptions. */
const SETTINGS_CARDS = [
  {
    title: "Agent approvals",
    description: "Choose which agent actions run at once, which wait for you, and which never run.",
    action: "5.5rem",
    content: false,
  },
  { title: "Team", description: null, action: null, content: false },
] as const

/** Project Settings until every card's data is there. */
export function ProjectSettingsSkeleton() {
  return (
    <PageBodySkeleton label="Loading settings" className="max-w-4xl">
      <PageHeadingSkeleton
        label="Project"
        title="Settings"
        description="Who works on this project and what agents can do in it."
      />
      <section className="flex flex-col gap-4">
        {SETTINGS_CARDS.map((card) => (
          <Card key={card.title}>
            <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Bar width="1.25rem" height="1.25rem" className="mt-0.5" />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <CardTitle>
                    <h3>{card.title}</h3>
                  </CardTitle>
                  {card.description ? (
                    <CardDescription>{card.description}</CardDescription>
                  ) : (
                    <TextBar width="22rem" className="text-sm leading-6" />
                  )}
                </div>
              </div>
              {card.action ? <Bar width={card.action} height="2.25rem" className="rounded-md" /> : null}
            </CardHeader>
            {card.content ? (
              <CardContent className="flex flex-col gap-4">
                <TextBar width="9rem" className="font-mono text-xs" />
                <Bar width="12rem" height="2.25rem" className="rounded-md" />
              </CardContent>
            ) : null}
          </Card>
        ))}
      </section>
    </PageBodySkeleton>
  )
}

/** Agent approvals settings: back link, heading, and the rows of the settings list. */
export function ProjectApprovalsSkeleton() {
  return (
    <PageBodySkeleton label="Loading approval settings" className="max-w-3xl">
      <TextBar width="4.5rem" className="text-sm" />
      <PageHeadingSkeleton
        label="Project settings"
        title="Agent approvals"
        description="What agents can do in this project without asking you. These settings win over each member's own defaults."
      />
      <section className="flex flex-col gap-4">
        <ul className="surface-card divide-y divide-border">
          {["11rem", "9rem", "12.5rem", "10rem", "13rem", "9.5rem"].map((width, index) => (
            <li key={index} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <TextBar width={width} className="text-[13px] font-medium" />
                <TextBar width="16rem" className="text-xs" />
              </div>
              <Bar width="13rem" height="2rem" className="rounded-md" />
            </li>
          ))}
        </ul>
      </section>
    </PageBodySkeleton>
  )
}
