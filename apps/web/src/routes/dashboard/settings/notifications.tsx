import { createFileRoute } from "@tanstack/react-router"

import { EmailNotificationsPage } from "~/components/dashboard/settings/email-notifications-page"
import { dashboardPendingView } from "~/components/dashboard/pending-view"
import { projectPagePending } from "~/components/dashboard/route-pending"

export const Route = createFileRoute("/dashboard/settings/notifications")({
  // The page skeleton, not a spinner: one loading state per visit.
  ...projectPagePending,
  pendingComponent: dashboardPendingView("emailNotifications"),
  component: EmailNotificationsPage,
})
