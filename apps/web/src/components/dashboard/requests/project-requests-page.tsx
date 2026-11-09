import { useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot, ChevronRight } from "lucide-react"
import type { ApprovalRequestSummary } from "@doxahq/contracts/approval-requests"

import { EmptyState, PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { ApprovalStatusBadge } from "~/components/dashboard/requests/approval-status-badge"
import { RequestFilters } from "~/components/dashboard/requests/request-filters"
import { RelativeDate } from "~/components/dashboard/exact-date-tooltip"
import { Button } from "~/components/ui/button"
import { Alert, AlertDescription } from "~/components/ui/alert"
import {
  filterRequestsByAgent,
  requestAgentOptions,
  statusQueryParam,
  type RequestAgentFilter,
  type RequestStatusFilter,
} from "~/lib/dashboard/approval-request-filters"
import { requesterLabel } from "~/lib/dashboard/approval-request-model"
import { getErrorMessage } from "~/lib/errors"
import { approvalRequestListQueryOptions } from "~/lib/queries/approval-requests"
import { cn } from "~/lib/utils"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { ProjectRequestsSkeleton } from "~/components/dashboard/skeletons/request-skeletons"

/** Every request that agents made in this project, newest first. */
export function ProjectRequestsPage({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<RequestStatusFilter>("all")
  const [agent, setAgent] = useState<RequestAgentFilter>("all")
  const requests = useQuery({
    ...approvalRequestListQueryOptions(projectId, statusQueryParam(status)),
    // The list stays on screen while another status loads.
    placeholderData: keepPreviousData,
  })
  const loaded = requests.data?.requests ?? []
  const items = filterRequestsByAgent(loaded, agent)
  const isFiltered = status !== "all" || agent !== "all"

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: requests.isPending }])
  if (isFirstLoad) return <ProjectRequestsSkeleton />

  return (
    <PageBody className="max-w-4xl">
      <PageHeading
        label="Requests"
        title="Agent requests"
        description="Actions that connected agents asked to run in this project. Pending requests wait for your decision."
      />
      <div className="flex flex-col gap-3">
        <RequestFilters
          status={status}
          onStatusChange={setStatus}
          agent={agent}
          agentOptions={requestAgentOptions(loaded, agent)}
          onAgentChange={setAgent}
        />
        {requests.error ? (
          <Alert variant="destructive">
            <AlertDescription>{getErrorMessage(requests.error, "The requests could not be loaded.")}</AlertDescription>
          </Alert>
        ) : null}
        {requests.isSuccess && !requests.isPlaceholderData && items.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={<Bot />}
              className="max-w-none"
              title="No matching requests"
              description="No request matches these filters."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setStatus("all")
                    setAgent("all")
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Bot />}
              className="max-w-none"
              title="No requests"
              description="When an agent asks to publish or change this project, the request shows here."
            />
          )
        ) : null}
        {items.length > 0 ? (
          <ul className={cn("border border-border", requests.isPlaceholderData && "opacity-60")}>
            {items.map((request, index) => (
              <RequestRow key={request.id} projectId={projectId} request={request} first={index === 0} />
            ))}
          </ul>
        ) : null}
      </div>
    </PageBody>
  )
}

/** Only a pending request opens: a decided request has nothing left to review. */
function RequestRow({
  projectId,
  request,
  first,
}: {
  projectId: string
  request: ApprovalRequestSummary
  first: boolean
}) {
  const content = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{request.headline}</span>
        <span className="text-xs text-muted-foreground">
          {requesterLabel(request.requestedBy)} · <RelativeDate date={request.createdAt} />
        </span>
      </div>
      <ApprovalStatusBadge status={request.status} />
    </>
  )
  return (
    <li className={first ? undefined : "border-t border-border"}>
      {request.status === "pending" ? (
        <Link
          to="/approve/$requestId"
          params={{ requestId: request.id }}
          className="flex items-center gap-4 px-4 py-3 hover:bg-surface-hover"
          aria-label={`${request.headline}, ${request.status}`}
          data-project={projectId}
        >
          {content}
          <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
        </Link>
      ) : (
        // The empty slot keeps the badges aligned with the pending rows.
        <div className="flex items-center gap-4 px-4 py-3" data-project={projectId}>
          {content}
          <span aria-hidden="true" className="size-4" />
        </div>
      )}
    </li>
  )
}
