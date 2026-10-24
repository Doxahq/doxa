import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"

import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { approvalRequestLinkQueryOptions } from "~/lib/queries/approval-requests"

/**
 * The link an agent gives the user: `/approve/<id>`. A publish opens the
 * content editor on the agent's branch with the publish menu; every other
 * action opens the approval page (spec 12.3).
 */
export function ApprovalLinkPage({ requestId }: { requestId: string }) {
  const link = useQuery(approvalRequestLinkQueryOptions(requestId))
  const navigate = useNavigate()

  useEffect(() => {
    const target = link.data
    if (!target?.projectId) return
    const projectId = target.projectId
    if (target.reviewSurface.kind === "publish_menu" && target.branchId) {
      void navigate({ to: "/dashboard/projects/$projectId/content", params: { projectId }, search: { request: requestId }, replace: true })
      return
    }
    void navigate({ to: "/dashboard/projects/$projectId/requests/$requestId", params: { projectId, requestId }, replace: true })
  }, [link.data, navigate, requestId])

  if (link.error || (link.data && !link.data.projectId)) {
    return (
      <AuthCard>
        <AuthCardHeading
          title="Request not found"
          description="This request does not exist, or it belongs to another account. Sign in with the account that connected the agent."
        />
      </AuthCard>
    )
  }
  return (
    <AuthCard>
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Opening the request…
      </div>
    </AuthCard>
  )
}
