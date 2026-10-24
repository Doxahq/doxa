import { useQuery } from "@tanstack/react-query"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"

import { FieldList, FieldRow, PageBody, PageHeading, SectionLabel } from "~/components/dashboard/dashboard-header"
import { ApprovalDecision } from "~/components/dashboard/requests/approval-decision"
import { ApprovalStatusBadge } from "~/components/dashboard/requests/approval-status-badge"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { formatRequestAge, requesterLabel } from "~/lib/dashboard/approval-request-model"
import { policySourceLabel } from "~/lib/dashboard/approval-settings-model"
import { getErrorMessage } from "~/lib/errors"
import { ApprovalRequestSkeleton } from "~/components/dashboard/skeletons/request-skeletons"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { approvalRequestQueryOptions } from "~/lib/queries/approval-requests"

/** Spec 12.5: the review of one request that is not a publish. */
export function ApprovalRequestPage({ projectId, requestId }: { projectId: string; requestId: string }) {
  const query = useQuery(approvalRequestQueryOptions(projectId, requestId))

  // The skeleton is for the first load only (see `useIsFirstLoad`).
  const isFirstLoad = useIsFirstLoad([{ isPending: query.isPending }])
  if (isFirstLoad) return <ApprovalRequestSkeleton />

  return (
    <PageBody className="max-w-3xl">
      {query.error ? (
        <Alert variant="destructive">
          <AlertDescription>{getErrorMessage(query.error, "This request could not be loaded.")}</AlertDescription>
        </Alert>
      ) : null}
      {query.data ? <RequestReview request={query.data} /> : null}
    </PageBody>
  )
}

function RequestReview({ request }: { request: DashboardApprovalRequest }) {
  const inputs = Object.entries(request.inputs)
  return (
    <div className="flex flex-col gap-6">
      <PageHeading
        label={request.title}
        title={request.headline}
        description={`Requested by ${requesterLabel(request.requestedBy)} ${formatRequestAge(request.createdAt)}. It needs approval because of ${policySourceLabel(request.policySource)}.`}
        actions={<ApprovalStatusBadge status={request.status} />}
      />
      {request.summary ? (
        <blockquote className="border-l-2 border-border pl-3 text-sm text-body">{request.summary}</blockquote>
      ) : null}
      <section className="flex flex-col gap-2">
        <SectionLabel>What happens</SectionLabel>
        <ul className="list-disc pl-5 text-sm text-body">
          {request.effects.map((effect) => <li key={effect}>{effect}</li>)}
        </ul>
      </section>
      {inputs.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionLabel>Details</SectionLabel>
          <FieldList>
            {inputs.map(([key, value]) => (
              <FieldRow key={key} label={key}>
                <span className="font-mono text-xs">{String(value)}</span>
              </FieldRow>
            ))}
          </FieldList>
        </section>
      ) : null}
      <div className="surface-card p-4">
        <ApprovalDecision request={request} />
      </div>
    </div>
  )
}
