import { ArrowLeft, Link2 } from "lucide-react"
import type { DashboardApprovalRequest } from "@doxahq/contracts/approval-requests"

import { RelativeDate } from "~/components/dashboard/exact-date-tooltip"
import { ApprovalChangedPages } from "~/components/dashboard/content/branches/approval-changed-pages"
import type { PublishMenuProps } from "~/components/dashboard/content/branches/publish-menu"
import {
  MdxBlockedPages,
  openPage,
  PanelHeader,
  pageTitle,
} from "~/components/dashboard/content/branches/publish-menu-parts"
import { ApprovalDecision } from "~/components/dashboard/requests/approval-decision"
import { MenuSectionLabel } from "~/components/dashboard/shell/menu-parts"
import { Button } from "~/components/ui/button"
import { erasedBranchOnApprove, requesterLabel } from "~/lib/dashboard/approval-request-model"

/**
 * Spec 12.4: an agent's publish request, approved from the publish menu.
 * The agent's note, the changed pages and the decision fields fill the
 * body; Back and the decision buttons share the footer. Each changed page
 * opens its diff against main in the editor (v2 spec 6.2).
 */
export function ApprovalPanel(props: PublishMenuProps & {
  request: DashboardApprovalRequest
  onPreview: () => void
  onBack: () => void
}) {
  const { request } = props
  return (
    <div className="flex min-h-[min(580px,calc(100vh-7rem))] flex-col">
      <PanelHeader
        title={`Publish to ${props.host}`}
        description={
          <>
            Requested by {requesterLabel(request.requestedBy)} <RelativeDate date={request.createdAt} />
          </>
        }
      />
      {request.summary ? (
        <section className="px-5 pt-5">
          <MenuSectionLabel>Agent's note</MenuSectionLabel>
          <blockquote className="mt-2 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground">
            {request.summary}
          </blockquote>
        </section>
      ) : null}
      {/* An approved publish fails while these pages fail the check. */}
      <MdxBlockedPages
        pages={props.state.mdxIssuePages}
        titleOf={(href) => pageTitle(props.state, href)}
        onOpenPage={(href) => openPage(props, href)}
      />
      <div className="pt-2">
        <ApprovalChangedPages
          projectId={props.projectId}
          branch={props.branch}
          onOpenPageDiff={props.onOpenPageDiff}
        />
      </div>
      <ApprovalDecision
        request={request}
        approveLabel="Approve and publish"
        onApproved={(detail) => {
          if (erasedBranchOnApprove(detail)) props.onBranchErased()
        }}
        className="flex-1 gap-0"
        bodyClassName="gap-4 px-5 pt-2 pb-5"
        footerClassName="mt-auto border-t border-divider px-5 py-3.5"
        footerStart={
          <>
            <Button type="button" variant="outline" size="sm" onClick={props.onBack}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!props.preview.canBuild} onClick={props.onPreview}>
              <Link2 aria-hidden="true" />
              Preview URL
            </Button>
          </>
        }
      />
    </div>
  )
}
