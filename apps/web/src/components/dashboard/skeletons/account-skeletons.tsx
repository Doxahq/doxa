import type { ReactNode } from "react"
import { Github } from "lucide-react"

import { DashboardHeader, SectionDescription, SectionLabel } from "~/components/dashboard/dashboard-header"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import {
  Bar,
  BadgeBar,
  FieldListSkeleton,
  PageBodySkeleton,
  PageHeadingSkeleton,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"
import { ACCOUNT_PAGES, type AccountPage } from "~/lib/dashboard/account-pages"
import { cn } from "~/lib/utils"

/** The top bar and the heading of one account settings page, as `AccountPageFrame` draws them. */
function AccountPageSkeleton({ page, children }: { page: AccountPage; children: ReactNode }) {
  return (
    <>
      <AccountTopBar crumbs={[page.title]} />
      <PageBodySkeleton label={`Loading ${page.title.toLowerCase()}`}>
        <PageHeadingSkeleton label={page.group} title={page.title} description={page.description} />
        {children}
      </PageBodySkeleton>
    </>
  )
}

/** Account settings until the profile and the GitHub connection are there. */
export function AccountSettingsSkeleton() {
  return (
    <AccountPageSkeleton page={ACCOUNT_PAGES.account}>
      <SectionSkeleton title="Profile">
        <FieldListSkeleton rows={[{ label: "Name", width: "8rem" }, { label: "Email", width: "13rem" }]} />
      </SectionSkeleton>
      <SectionSkeleton title="GitHub connection">
        {/* The real section's parts: the GitHub mark, one line of status,
            the outlined state tag, and the small action button. */}
        <div className="surface-card flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Github aria-hidden="true" className="size-4 text-muted-foreground" />
              <TextBar width="9.5rem" className="text-sm" />
            </div>
            <OutlinedBox width="6.75rem" height="1.25rem" barWidth="4.75rem" tag />
          </div>
          <div>
            <OutlinedBox width="10.5rem" height="2rem" barWidth="7.5rem" icon />
          </div>
        </div>
      </SectionSkeleton>
    </AccountPageSkeleton>
  )
}

/** Email notifications: one switch row for each kind of email. */
export function EmailNotificationsSkeleton() {
  return (
    <AccountPageSkeleton page={ACCOUNT_PAGES.emailNotifications}>
      <SwitchRowsSkeleton widths={["10rem", "12rem", "9rem"]} />
    </AccountPageSkeleton>
  )
}

/** Connected agents: a few agent rows. */
export function ConnectedAgentsSkeleton() {
  return (
    <AccountPageSkeleton page={ACCOUNT_PAGES.connectedAgents}>
      <ListRowsSkeleton widths={["9rem", "11rem"]} />
    </AccountPageSkeleton>
  )
}

/** Agent approvals: the action rows with their Allow, Ask me and Block control. */
export function AgentApprovalsSkeleton() {
  return (
    <AccountPageSkeleton page={ACCOUNT_PAGES.agentApprovals}>
      <ListRowsSkeleton widths={["11rem", "9rem", "12.5rem", "10rem"]} control="13rem" />
    </AccountPageSkeleton>
  )
}

/** Teams: the heading, the create form and the list of teams. */
export function TeamsSkeleton() {
  return (
    <>
      <DashboardHeader title="Teams" />
      <PageBodySkeleton label="Loading teams">
        <PageHeadingSkeleton
          label="Account"
          title="Teams"
          description="A team shares projects with its members. Each member's role decides what they and their agents can do."
        />
        <SectionSkeleton title="Create a team">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Bar width="100%" height="2.25rem" className="rounded-md" />
            <Bar width="7.5rem" height="2.25rem" className="rounded-md" />
          </div>
        </SectionSkeleton>
        <SectionSkeleton title="Your teams">
          <TeamRowsSkeleton widths={["8rem", "11rem", "9.5rem"]} />
        </SectionSkeleton>
      </PageBodySkeleton>
    </>
  )
}

/** One team: back link, heading, then the members and the projects. */
export function TeamSkeleton() {
  return (
    <>
      <DashboardHeader title="Team" />
      <PageBodySkeleton label="Loading team">
        <TextBar width="4rem" className="text-sm" />
        <PageHeadingSkeleton label="Team" titleWidth="9rem" description={<TextBar width="14rem" className="text-sm leading-6" />} />
        <SectionSkeleton title="Members">
          <TeamRowsSkeleton widths={["9rem", "11rem", "8rem"]} />
        </SectionSkeleton>
        <SectionSkeleton title="Projects">
          <TeamRowsSkeleton widths={["10rem", "7.5rem"]} />
        </SectionSkeleton>
      </PageBodySkeleton>
    </>
  )
}

function SectionSkeleton({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {description ? (
        <div className="flex flex-col gap-1">
          <SectionLabel>{title}</SectionLabel>
          <SectionDescription>{description}</SectionDescription>
        </div>
      ) : (
        <SectionLabel>{title}</SectionLabel>
      )}
      {children}
    </section>
  )
}

/** Rows with a name and a detail line, and a role badge on the right, as the team lists draw them. */
function TeamRowsSkeleton({ widths }: { widths: readonly string[] }) {
  return (
    <ul className="surface-card">
      {widths.map((width, index) => (
        <li key={index} className="flex items-center justify-between gap-4 border-t border-divider px-5 py-4 first:border-t-0">
          <span className="flex min-w-0 flex-col gap-1">
            <TextBar width={width} className="text-[14.5px] font-medium" />
            <TextBar width="7rem" className="text-xs" />
          </span>
          <BadgeBar width="4rem" />
        </li>
      ))}
    </ul>
  )
}

/** Switch rows: a title and a description, and the switch on the right. */
function SwitchRowsSkeleton({ widths }: { widths: readonly string[] }) {
  return (
    <div className="surface-card divide-y divide-border px-5">
      {widths.map((width, index) => (
        <div key={index} className="flex items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <TextBar width={width} className="text-sm font-medium" />
            <TextBar width="16rem" className="text-xs" />
          </div>
          <Bar width="2.25rem" height="1.25rem" className="rounded-full" />
        </div>
      ))}
    </div>
  )
}

/** List rows with two lines of text and a control on the right. */
function ListRowsSkeleton({ widths, control = "5rem" }: { widths: readonly string[]; control?: string }) {
  return (
    <ul className="surface-card divide-y divide-border">
      {widths.map((width, index) => (
        <li key={index} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <TextBar width={width} className="text-[13px] font-medium" />
            <TextBar width="14rem" className="text-xs" />
          </div>
          <Bar width={control} height="2rem" className="rounded-md" />
        </li>
      ))}
    </ul>
  )
}

/**
 * A bordered box with a short bar inside: the shape of a tag or an outlined
 * button, whose border is known before its label is.
 */
function OutlinedBox({
  width,
  height,
  barWidth,
  icon = false,
  tag = false,
}: {
  width: string
  height: string
  barWidth: string
  /** Room for the button's icon before its label. */
  icon?: boolean
  /** A tag's smaller corners and padding, as `Badge` draws them. */
  tag?: boolean
}) {
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5 border border-border", tag ? "rounded-sm px-2" : "rounded-md px-2.5")}
      style={{ width, height }}
    >
      {icon ? <Bar width="1rem" height="1rem" /> : null}
      <Bar width={barWidth} height="0.55rem" />
    </span>
  )
}
